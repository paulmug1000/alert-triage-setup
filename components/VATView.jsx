import React, { useState, useEffect, useMemo, useCallback } from "react";
import Spinner from "./Spinner";
import EditClientSelector from "./EditClientSelector";
import { PmaVatSkeleton } from "./Skeleton";
import { useAuth } from "../hooks/useAuth";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { useFocusRevalidate } from "../hooks/useFocusRevalidate";
import { formatMoney as universalFormatMoney } from "../services/deepDiveHelper";

function isCompleteTaxesPayload_(data) {
  return Boolean(
    data &&
    data.success &&
    Array.isArray(data.sections) &&
    Array.isArray(data.otherSections) &&
    data.corpTax &&
    Array.isArray(data.corpTax.sections) &&
    Array.isArray(data.fyConfigs)
  );
}

export default function VATView({
  allOutgoingsClients = [],
  styles = {},
  managedClient,
  onClearManagedClient,
  initialClient,
  onSelectClient,
}) {
  const { user } = useAuth();
  const isSysAdmin = Boolean(!user?.isReadOnly && (user?.isAdmin || user?.role === "Admin"));
  const canEditCorpTax = Boolean(
    !user?.isReadOnly &&
    (user?.isAdmin || user?.role === "Admin" || user?.role === "ClientManager")
  );
  const { getCachedClientData, setCachedClientData, getInFlightPrefetch, cleanSheetId } = useAppGlobals();

  const [selectedClient, setSelectedClient] = useState(() => {
    if (managedClient) {
      return (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()
      ) || managedClient;
    }
    if (initialClient) {
      const targetStr = typeof initialClient === "string"
        ? initialClient.toLowerCase()
        : initialClient?.clientName?.toLowerCase();
      return (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === targetStr
      ) || (typeof initialClient === "object" ? initialClient : null);
    }
    return null;
  });

  const [vatData, setVatData] = useState(() => {
    const target = managedClient || (typeof initialClient === "object" ? initialClient : null);
    if (target?.clientSheetId) {
      const cached = getCachedClientData(target.clientSheetId, "vat");
      if (isCompleteTaxesPayload_(cached?.data)) return cached.data;
    }
    return null;
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedFyIdx, setSelectedFyIdx] = useState(() => vatData?.defaultFyIndex ?? 0);
  const [showOtherVatScheme, setShowOtherVatScheme] = useState(false);
  const [rateDrafts, setRateDrafts] = useState({});
  const [savingSection, setSavingSection] = useState(null);
  const [saveFeedback, setSaveFeedback] = useState({});

  // Sync client selection from managedClient or initialClient
  useEffect(() => {
    if (managedClient) {
      const match = (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === managedClient.clientName?.toLowerCase()
      ) || managedClient;
      setSelectedClient((prev) => {
        if (prev?.clientName?.toLowerCase() !== match?.clientName?.toLowerCase()) {
          setVatData(null);
          setLoading(true);
          setShowOtherVatScheme(false);
          setSaveFeedback({});
        }
        return match;
      });
      return;
    }
    if (initialClient) {
      const targetStr = typeof initialClient === "string"
        ? initialClient.toLowerCase()
        : initialClient?.clientName?.toLowerCase();
      const match = (allOutgoingsClients || []).find(
        (c) => c.clientName?.toLowerCase() === targetStr
      ) || (typeof initialClient === "object" ? initialClient : null);
      if (match) {
        setSelectedClient((prev) => {
          if (prev?.clientName?.toLowerCase() !== match?.clientName?.toLowerCase()) {
            setVatData(null);
            setLoading(true);
            setShowOtherVatScheme(false);
            setSaveFeedback({});
          }
          return match;
        });
      }
    }
  }, [managedClient, initialClient, allOutgoingsClients]);

  const handleBackToClients = () => {
    setShowOtherVatScheme(false);
    setSaveFeedback({});
    if (managedClient && onClearManagedClient) {
      onClearManagedClient();
    } else {
      setSelectedClient(null);
      setVatData(null);
      onSelectClient?.(null);
      if (typeof window !== "undefined") {
        sessionStorage.removeItem("pma_vat_client");
      }
    }
  };

  const fetchVatData = useCallback(async (client, bypassCache = false, silent = false) => {
    if (!client || !client.clientSheetId) return;
    const cleanId = cleanSheetId ? cleanSheetId(client.clientSheetId) : client.clientSheetId;

    const cached = !bypassCache ? getCachedClientData(client.clientSheetId, "vat") : null;
    if (isCompleteTaxesPayload_(cached?.data)) {
      setVatData(cached.data);
      if (!silent) {
        setSelectedFyIdx(cached.data.defaultFyIndex ?? 0);
        setLoading(false);
      }
      if (!cached.isStale) return;
    } else if (!silent) {
      setLoading(true);
    }

    if (!bypassCache && typeof getInFlightPrefetch === "function") {
      const inFlight = getInFlightPrefetch(`vat_${cleanId}`);
      if (inFlight) {
        try {
          await inFlight;
          const fresh = getCachedClientData(client.clientSheetId, "vat");
          if (isCompleteTaxesPayload_(fresh?.data)) {
            setVatData(fresh.data);
            if (!silent) {
              setSelectedFyIdx(fresh.data.defaultFyIndex ?? 0);
              setLoading(false);
            }
            return;
          }
        } catch { }
      }
    }

    if (!silent) setError(null);
    try {
      const res = await fetch(
        `/api/pma/vat?clientName=${encodeURIComponent(client.clientName || "")}&clientSheetId=${encodeURIComponent(
          client.clientSheetId
        )}${bypassCache ? "&bypassCache=true" : ""}`
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to load taxes data");
      }
      setVatData(data);
      if (!silent) {
        setSelectedFyIdx(data.defaultFyIndex ?? 0);
      }
      setCachedClientData(client.clientSheetId, "vat", data);
    } catch (err) {
      console.error("Failed to fetch taxes data:", err);
      if (!silent) setError(err.message || "Failed to load taxes data");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [cleanSheetId, getCachedClientData, setCachedClientData, getInFlightPrefetch]);

  useEffect(() => {
    if (selectedClient) {
      if (typeof window !== "undefined") {
        sessionStorage.setItem("pma_vat_client", selectedClient.clientName);
      }
      fetchVatData(selectedClient);
    }
  }, [selectedClient, fetchVatData]);

  useFocusRevalidate({
    enabled: Boolean(selectedClient?.clientSheetId),
    resetKey: selectedClient?.clientSheetId || "",
    canRevalidate: () => !loading && !savingSection,
    onRevalidate: () => {
      if (selectedClient?.clientSheetId) {
        fetchVatData(selectedClient, true, true);
      }
    },
  });

  const fyConfigs = vatData?.fyConfigs || [];
  const currentFy = fyConfigs[selectedFyIdx] || fyConfigs[0] || null;
  const maxFyIdx = fyConfigs.length > 0 ? fyConfigs.length - 1 : 0;

  // Sync draft corp tax rates whenever payload or selected FY changes
  useEffect(() => {
    if (!vatData?.corpTax?.sections || !currentFy?.id) return;
    const fyId = currentFy.id;
    setRateDrafts((prev) => {
      const next = { ...prev };
      for (const sec of vatData.corpTax.sections) {
        const key = `${sec.key}_${fyId}`;
        const pct = sec.ratesByFy?.[fyId]?.pct;
        next[key] = pct !== null && pct !== undefined ? String(pct) : "";
      }
      return next;
    });
  }, [vatData, currentFy?.id]);

  const rawSymbol = vatData?.currencySymbol || selectedClient?.currencySymbol || "£";
  const currencySymbol = rawSymbol === "EUR" ? "€" : rawSymbol === "GBP" ? "£" : rawSymbol === "USD" ? "$" : rawSymbol;
  const thousandsSeparator = vatData?.thousandsSeparator || (currencySymbol === "€" ? "." : ",");

  const formatMoney = useCallback((val) => {
    const num = typeof val === "number" && !isNaN(val) ? val : 0;
    const normalized = Math.abs(num) < 0.005 ? 0 : num;
    return universalFormatMoney(normalized, 2, currencySymbol, thousandsSeparator);
  }, [currencySymbol, thousandsSeparator]);

  const formatPercent = useCallback((val) => {
    const num = typeof val === "number" && !isNaN(val) ? val : 0;
    const pct = Math.abs(num * 100) < 0.05 ? 0 : num * 100;
    return `${pct.toFixed(1)}%`;
  }, []);

  const fyDateRangeLabel = useMemo(() => {
    const months = currentFy?.monthCols || [];
    if (!months.length) return "";
    return `${months[0].label} – ${months[months.length - 1].label}`;
  }, [currentFy]);

  const handleSaveCorpTaxRate = async (section) => {
    if (!selectedClient?.clientSheetId || !currentFy?.id || !canEditCorpTax) return;
    const fyId = currentFy.id;
    const draftKey = `${section.key}_${fyId}`;
    const rawDraft = rateDrafts[draftKey];
    const parsedPct = parseFloat(String(rawDraft ?? "").trim());
    if (!Number.isFinite(parsedPct) || parsedPct < 0 || parsedPct > 100) {
      setSaveFeedback((prev) => ({
        ...prev,
        [section.key]: { type: "error", message: "Enter a percentage between 0 and 100." },
      }));
      return;
    }

    setSavingSection(section.key);
    setSaveFeedback((prev) => {
      const next = { ...prev };
      delete next[section.key];
      return next;
    });

    try {
      const res = await fetch("/api/pma/vat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_corp_tax_rate",
          clientName: selectedClient.clientName || "",
          clientSheetId: selectedClient.clientSheetId,
          section: section.key,
          fyId,
          fyLabel: currentFy.label,
          ratePct: parsedPct,
        }),
      });
      const resData = await res.json();
      if (!res.ok || !resData.success) {
        throw new Error(resData.error || "Failed to update corporation tax rate");
      }
      if (resData.data) {
        setVatData(resData.data);
        setCachedClientData(selectedClient.clientSheetId, "vat", resData.data);
      }
      setSaveFeedback((prev) => ({
        ...prev,
        [section.key]: { type: "success", message: "Saved" },
      }));
      setTimeout(() => {
        setSaveFeedback((prev) => {
          if (prev[section.key]?.type !== "success") return prev;
          const next = { ...prev };
          delete next[section.key];
          return next;
        });
      }, 2500);
    } catch (err) {
      console.error("Failed to save corporation tax rate:", err);
      setSaveFeedback((prev) => ({
        ...prev,
        [section.key]: { type: "error", message: err.message || "Failed to save rate" },
      }));
    } finally {
      setSavingSection(null);
    }
  };

  const renderTableColGroup = () => (
    <colgroup>
      <col style={{ width: "18.5%" }} />
      {currentFy.monthCols.map((m, mIdx) => (
        <col key={m.colIdx ?? `col_${mIdx}`} style={{ width: "6.1%" }} />
      ))}
      <col style={{ width: "8.3%" }} />
    </colgroup>
  );

  const renderVatTable = (section, keyPrefix = "primary") => {
    const returnTotals = section.vatReturnTotalsByFy?.[currentFy.id] || {
      groups: [],
      isFullyAlignedFy: false,
      fyReturnSum: null,
    };
    const firstRowNum = section.rows[0]?.sheetRow;
    const lastRowNum = section.rows[section.rows.length - 1]?.sheetRow;

    return (
      <div
        key={`${keyPrefix}_${section.key}`}
        style={{
          background: "#ffffff",
          borderRadius: "8px",
          border: "1px solid #cbd5e1",
          boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
          overflow: "hidden",
          marginBottom: "20px",
        }}
      >
        {/* Card section header */}
        <div
          style={{
            padding: "11px 16px",
            background: "#f8fafc",
            borderBottom: "1px solid #cbd5e1",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
            {section.title}
          </h3>
          {isSysAdmin && firstRowNum && lastRowNum && (
            <span style={{ fontSize: "11px", fontWeight: 600, color: "#64748b" }}>
              VAT!Rows {firstRowNum - 1}–{lastRowNum}
            </span>
          )}
        </div>

        {/* Responsive monthly matrix table */}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: "1040px", tableLayout: "fixed", borderCollapse: "collapse", fontSize: "11.5px", textAlign: "right" }}>
            {renderTableColGroup()}
            <thead>
              <tr style={{ background: "#f1f5f9", borderBottom: "1px solid #cbd5e1" }}>
                <th
                  style={{
                    padding: "8px 10px",
                    textAlign: "left",
                    fontWeight: 700,
                    color: "#475569",
                    position: "sticky",
                    left: 0,
                    zIndex: 2,
                    background: "#f1f5f9",
                    borderRight: "1px solid #e2e8f0",
                    whiteSpace: "normal",
                    lineHeight: 1.3,
                  }}
                >
                  Line item
                </th>
                {currentFy.monthCols.map((m, mIdx) => (
                  <th
                    key={m.colIdx ?? `${m.label}_${mIdx}`}
                    style={{
                      padding: "8px 4px",
                      fontWeight: 700,
                      color: "#475569",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {m.label}
                  </th>
                ))}
                <th
                  style={{
                    padding: "8px 8px",
                    fontWeight: 800,
                    color: "#0047AB",
                    background: "#eff6ff",
                    whiteSpace: "nowrap",
                    borderLeft: "1px solid #cbd5e1",
                  }}
                >
                  {currentFy.totalHeaderLabel || `${currentFy.label} total`}
                </th>
              </tr>
            </thead>

            <tbody>
              {section.rows.map((row, rIdx) => {
                const fyRow = row.fyData?.[currentFy.id] || { months: [], total: 0, isError: false };
                const isTotal = Boolean(row.isTotalRow);
                const rowBg = isTotal ? "#f8fafc" : "#ffffff";

                return (
                  <tr
                    key={`${row.label}_${row.sheetRow || rIdx}`}
                    style={{
                      background: rowBg,
                      borderTop: isTotal ? "1.5px solid #94a3b8" : "none",
                      borderBottom: isTotal ? "1.5px solid #cbd5e1" : "1px solid #f1f5f9",
                    }}
                  >
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "left",
                        fontWeight: isTotal ? 700 : 500,
                        color: isTotal ? "#0f172a" : "#334155",
                        position: "sticky",
                        left: 0,
                        zIndex: 1,
                        background: rowBg,
                        borderRight: "1px solid #e2e8f0",
                        whiteSpace: "normal",
                        lineHeight: 1.3,
                      }}
                    >
                      <span>{row.label}</span>
                      {isSysAdmin && row.sheetRow && (
                        <span style={{ fontSize: "10px", color: "#94a3b8", marginLeft: "6px", fontWeight: 500 }}>
                          (R{row.sheetRow})
                        </span>
                      )}
                    </td>

                    {fyRow.months.map((m, mIdx) => {
                      const isZero = !m.isError && Math.abs(m.value) < 0.005;
                      const isNeg = !m.isError && m.value < -0.005;
                      return (
                        <td
                          key={m.colIdx ?? mIdx}
                          style={{
                            padding: "8px 4px",
                            fontSize: "11px",
                            fontWeight: isTotal ? 700 : 500,
                            color: m.isError
                              ? "#b91c1c"
                              : isNeg
                                ? "#dc2626"
                                : isZero
                                  ? "#94a3b8"
                                  : "#0f172a",
                            fontVariantNumeric: "tabular-nums",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {m.isError ? (isSysAdmin ? m.rawDisplay : "Error") : formatMoney(m.value)}
                        </td>
                      );
                    })}

                    <td
                      style={{
                        padding: "8px 8px",
                        fontSize: "11.5px",
                        fontWeight: isTotal ? 800 : 700,
                        background: isTotal ? "#dbeafe" : "#f8fafc",
                        color: fyRow.isError
                          ? "#b91c1c"
                          : fyRow.total < -0.005
                            ? "#dc2626"
                            : "#0047AB",
                        borderLeft: "1px solid #cbd5e1",
                        fontVariantNumeric: "tabular-nums",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {fyRow.isError ? (isSysAdmin && fyRow.rawDisplay ? fyRow.rawDisplay : "Error") : formatMoney(fyRow.total)}
                    </td>
                  </tr>
                );
              })}

              {/* VAT return totals row directly under VAT owed to HMRC */}
              <tr
                style={{
                  background: "#eff6ff",
                  borderTop: "1px solid #bfdbfe",
                }}
              >
                <td
                  style={{
                    padding: "8px 10px",
                    textAlign: "left",
                    fontWeight: 700,
                    color: "#0047AB",
                    position: "sticky",
                    left: 0,
                    zIndex: 1,
                    background: "#eff6ff",
                    borderRight: "1px solid #bfdbfe",
                    whiteSpace: "normal",
                    lineHeight: 1.3,
                  }}
                >
                  <div>VAT return totals</div>
                  <div style={{ fontSize: "10.5px", fontWeight: 500, color: "#475569", marginTop: "1px" }}>
                    3-month VAT periods
                  </div>
                </td>

                {returnTotals.groups.map((grp) => {
                  const isNeg = grp.total < -0.005;
                  const isZero = Math.abs(grp.total) < 0.005;
                  const isPartial = grp.includedCount < 3;
                  const tooltipText = isPartial
                    ? `${grp.periodLabel}: includes ${grp.includedMonths.join(", ")} (${grp.includedCount} of 3 months available in forecast range)`
                    : `${grp.periodLabel}: ${grp.includedMonths.join(", ")}`;

                  return (
                    <td
                      key={grp.key}
                      colSpan={grp.colSpan}
                      title={tooltipText}
                      style={{
                        padding: "8px 4px",
                        textAlign: "center",
                        borderLeft: "1px solid #bfdbfe",
                        borderRight: "1px solid #bfdbfe",
                        background: "#f0f7ff",
                        verticalAlign: "middle",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "10.5px",
                          fontWeight: 600,
                          color: "#475569",
                          marginBottom: "2px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {grp.periodLabel}
                        {isPartial && (
                          <span style={{ color: "#b45309", marginLeft: "4px" }}>
                            ({grp.includedCount}/3 mo)
                          </span>
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: "12px",
                          fontWeight: 800,
                          color: isNeg ? "#dc2626" : isZero ? "#64748b" : "#0047AB",
                          fontVariantNumeric: "tabular-nums",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {formatMoney(grp.total)}
                      </div>
                    </td>
                  );
                })}

                <td
                  title={
                    returnTotals.isFullyAlignedFy
                      ? `Sum of ${currentFy.label} VAT returns`
                      : "VAT quarters span financial year boundaries"
                  }
                  style={{
                    padding: "8px 8px",
                    fontSize: "11.5px",
                    fontWeight: 800,
                    color:
                      returnTotals.fyReturnSum !== null && returnTotals.fyReturnSum < -0.005
                        ? "#dc2626"
                        : "#0047AB",
                    background: "#dbeafe",
                    borderLeft: "1px solid #bfdbfe",
                    fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap",
                    textAlign: returnTotals.fyReturnSum !== null ? "right" : "center",
                  }}
                >
                  {returnTotals.fyReturnSum !== null ? formatMoney(returnTotals.fyReturnSum) : "—"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderCorpTaxSection = (section) => {
    const fyId = currentFy.id;
    const rateInfo = section.ratesByFy?.[fyId] || {};
    const savedPct = rateInfo.pct !== null && rateInfo.pct !== undefined ? rateInfo.pct : null;
    const draftKey = `${section.key}_${fyId}`;
    const draftStr = rateDrafts[draftKey] ?? (savedPct !== null ? String(savedPct) : "");
    const parsedDraft = parseFloat(String(draftStr).trim());
    const isValidDraft = Number.isFinite(parsedDraft) && parsedDraft >= 0 && parsedDraft <= 100;
    const isDirty = isValidDraft && (savedPct === null || Math.abs(parsedDraft - savedPct) > 0.0001);
    const isSaving = savingSection === section.key;
    const feedback = saveFeedback[section.key];

    const firstRowNum = section.rows[0]?.sheetRow;
    const lastRowNum = section.rows[section.rows.length - 1]?.sheetRow;

    return (
      <div
        key={`corp_tax_${section.key}`}
        style={{
          background: "#ffffff",
          borderRadius: "8px",
          border: "1px solid #cbd5e1",
          boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
          overflow: "hidden",
          marginBottom: "20px",
        }}
      >
        {/* Card header with per-FY rate editor */}
        <div
          style={{
            padding: "11px 16px",
            background: "#f8fafc",
            borderBottom: "1px solid #cbd5e1",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
              {section.title}
            </h3>
            {isSysAdmin && firstRowNum && lastRowNum && (
              <span style={{ fontSize: "11px", fontWeight: 600, color: "#64748b" }}>
                Performance!Rows {firstRowNum}–{lastRowNum}
              </span>
            )}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
            <span style={{ fontSize: "12.5px", fontWeight: 600, color: "#475569" }}>
              Rate ({currentFy.label}):
            </span>

            {canEditCorpTax ? (
              <>
                <div style={{ display: "inline-flex", alignItems: "center", position: "relative" }}>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={draftStr}
                    disabled={isSaving}
                    onChange={(e) => {
                      const val = e.target.value;
                      setRateDrafts((prev) => ({ ...prev, [draftKey]: val }));
                      if (saveFeedback[section.key]) {
                        setSaveFeedback((prev) => {
                          const next = { ...prev };
                          delete next[section.key];
                          return next;
                        });
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && isDirty && !isSaving) {
                        e.preventDefault();
                        handleSaveCorpTaxRate(section);
                      }
                    }}
                    aria-label={`${section.title} rate for ${currentFy.label}`}
                    style={{
                      width: "78px",
                      padding: "4px 22px 4px 8px",
                      borderRadius: "5px",
                      border: "1px solid #cbd5e1",
                      fontSize: "13px",
                      fontWeight: 700,
                      color: "#0f172a",
                      textAlign: "right",
                      background: isSaving ? "#f1f5f9" : "#ffffff",
                      outline: "none",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  />
                  <span
                    style={{
                      position: "absolute",
                      right: "7px",
                      fontSize: "12px",
                      fontWeight: 600,
                      color: "#64748b",
                      pointerEvents: "none",
                    }}
                  >
                    %
                  </span>
                </div>

                <button
                  type="button"
                  disabled={!isDirty || isSaving}
                  onClick={() => handleSaveCorpTaxRate(section)}
                  style={{
                    padding: "5px 12px",
                    borderRadius: "5px",
                    border: "1px solid",
                    borderColor: isDirty && !isSaving ? "#0047AB" : "#cbd5e1",
                    background: isDirty && !isSaving ? "#0047AB" : "#f1f5f9",
                    color: isDirty && !isSaving ? "#ffffff" : "#94a3b8",
                    fontSize: "12px",
                    fontWeight: 700,
                    cursor: isDirty && !isSaving ? "pointer" : "not-allowed",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "5px",
                  }}
                >
                  {isSaving && <Spinner size={11} color="#64748b" />}
                  <span>{isSaving ? "Saving..." : "Save"}</span>
                </button>
              </>
            ) : (
              <span style={{ fontSize: "13px", fontWeight: 700, color: "#0f172a" }}>
                {rateInfo.isError
                  ? (isSysAdmin && rateInfo.rawDisplay ? rateInfo.rawDisplay : "Error")
                  : savedPct !== null
                    ? `${savedPct}%`
                    : "—"}
              </span>
            )}

            {isSysAdmin && rateInfo.colLetter && section.rateRow && (
              <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                (Performance!{rateInfo.colLetter}{section.rateRow})
              </span>
            )}

            {feedback && (
              <span
                style={{
                  fontSize: "12px",
                  fontWeight: 600,
                  color: feedback.type === "error" ? "#b91c1c" : "#15803d",
                }}
              >
                {feedback.message}
              </span>
            )}
          </div>
        </div>

        {/* Monthly matrix table */}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: "1040px", tableLayout: "fixed", borderCollapse: "collapse", fontSize: "11.5px", textAlign: "right" }}>
            {renderTableColGroup()}
            <thead>
              <tr style={{ background: "#f1f5f9", borderBottom: "1px solid #cbd5e1" }}>
                <th
                  style={{
                    padding: "8px 10px",
                    textAlign: "left",
                    fontWeight: 700,
                    color: "#475569",
                    position: "sticky",
                    left: 0,
                    zIndex: 2,
                    background: "#f1f5f9",
                    borderRight: "1px solid #e2e8f0",
                    whiteSpace: "normal",
                    lineHeight: 1.3,
                  }}
                >
                  Line item
                </th>
                {currentFy.monthCols.map((m, mIdx) => (
                  <th
                    key={m.colIdx ?? `${m.label}_${mIdx}`}
                    style={{
                      padding: "8px 4px",
                      fontWeight: 700,
                      color: "#475569",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {m.label}
                  </th>
                ))}
                <th
                  style={{
                    padding: "8px 8px",
                    fontWeight: 800,
                    color: "#0047AB",
                    background: "#eff6ff",
                    whiteSpace: "nowrap",
                    borderLeft: "1px solid #cbd5e1",
                  }}
                >
                  {currentFy.totalHeaderLabel || `${currentFy.label} total`}
                </th>
              </tr>
            </thead>

            <tbody>
              {section.rows.map((row, rIdx) => {
                const fyRow = row.fyData?.[fyId] || { months: [], total: 0, isError: false };
                const isPercent = row.valueType === "percent";
                const isHighlight = Boolean(row.isHighlight);
                const isFyTotalOnly = Boolean(row.fyTotalOnly);
                const isFirstFyTotalOnly = isFyTotalOnly && !section.rows[rIdx - 1]?.fyTotalOnly;
                const rowBg = isHighlight ? "#f8fafc" : isFyTotalOnly ? "#f8fafc" : "#ffffff";

                return (
                  <tr
                    key={`${row.label}_${row.sheetRow || rIdx}`}
                    style={{
                      background: rowBg,
                      borderTop: isFirstFyTotalOnly
                        ? "1.5px solid #94a3b8"
                        : isHighlight
                          ? "1px solid #cbd5e1"
                          : "none",
                      borderBottom: isHighlight
                        ? "1px solid #cbd5e1"
                        : "1px solid #f1f5f9",
                    }}
                  >
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "left",
                        fontWeight: isHighlight || row.isDifferenceRow ? 700 : 500,
                        fontStyle: isPercent ? "italic" : "normal",
                        color: isPercent
                          ? "#475569"
                          : isHighlight || row.isDifferenceRow
                            ? "#0f172a"
                            : "#334155",
                        position: "sticky",
                        left: 0,
                        zIndex: 1,
                        background: rowBg,
                        borderRight: "1px solid #e2e8f0",
                        whiteSpace: "normal",
                        lineHeight: 1.3,
                      }}
                    >
                      <span>{row.label}</span>
                      {isSysAdmin && row.sheetRow && (
                        <span style={{ fontSize: "10px", color: "#94a3b8", marginLeft: "6px", fontWeight: 500, fontStyle: "normal" }}>
                          (R{row.sheetRow})
                        </span>
                      )}
                    </td>

                    {fyRow.months.map((m, mIdx) => {
                      if (isFyTotalOnly || m.isBlank) {
                        return (
                          <td
                            key={m.colIdx ?? mIdx}
                            style={{
                              padding: "8px 4px",
                              fontSize: "11px",
                              color: "#cbd5e1",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {" "}
                          </td>
                        );
                      }
                      const threshold = isPercent ? 0.0005 : 0.005;
                      const isZero = !m.isError && Math.abs(m.value) < threshold;
                      const isNeg = !m.isError && m.value < -threshold;
                      return (
                        <td
                          key={m.colIdx ?? mIdx}
                          style={{
                            padding: "8px 4px",
                            fontSize: "11px",
                            fontWeight: isHighlight ? 700 : 500,
                            fontStyle: isPercent ? "italic" : "normal",
                            color: m.isError
                              ? "#b91c1c"
                              : isNeg
                                ? "#dc2626"
                                : isZero
                                  ? "#94a3b8"
                                  : isPercent
                                    ? "#475569"
                                    : "#0f172a",
                            fontVariantNumeric: "tabular-nums",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {m.isError
                            ? (isSysAdmin ? m.rawDisplay : "Error")
                            : isPercent
                              ? formatPercent(m.value)
                              : formatMoney(m.value)}
                        </td>
                      );
                    })}

                    <td
                      style={{
                        padding: "8px 8px",
                        fontSize: "11.5px",
                        fontWeight: isHighlight || row.isDifferenceRow ? 800 : 700,
                        fontStyle: isPercent ? "italic" : "normal",
                        background: isHighlight || isFyTotalOnly ? "#dbeafe" : "#f8fafc",
                        color: fyRow.isError
                          ? "#b91c1c"
                          : fyRow.total < (isPercent ? -0.0005 : -0.005)
                            ? "#dc2626"
                            : isPercent
                              ? "#334155"
                              : "#0047AB",
                        borderLeft: "1px solid #cbd5e1",
                        fontVariantNumeric: "tabular-nums",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {fyRow.isError
                        ? (isSysAdmin && fyRow.rawDisplay ? fyRow.rawDisplay : "Error")
                        : isPercent
                          ? formatPercent(fyRow.total)
                          : formatMoney(fyRow.total)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div style={{ ...styles.container, maxWidth: "1520px", margin: "0 auto", padding: "20px 20px 48px" }}>
      {/* ── HEADER BAR ── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "20px",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {selectedClient && !managedClient && (
            <button
              type="button"
              onClick={handleBackToClients}
              style={{
                backgroundColor: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                color: "#475569",
                cursor: "pointer",
                fontSize: "16px",
                width: "34px",
                height: "34px",
                display: "flex",
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
              <span>Taxes</span>
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
            {!canEditCorpTax && (
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 600,
                  color: "#64748b",
                  background: "#f1f5f9",
                  border: "1px solid #e2e8f0",
                  borderRadius: "999px",
                  padding: "3px 10px",
                }}
              >
                Read-only
              </span>
            )}

            {/* FY Navigator */}
            {fyConfigs.length > 0 && (
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
                  aria-label="Select financial year"
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
                  {fyConfigs.map((fy, idx) => (
                    <option key={fy.id} value={idx}>
                      {fy.label}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  onClick={() => setSelectedFyIdx((prev) => Math.min(maxFyIdx, prev + 1))}
                  disabled={selectedFyIdx >= maxFyIdx}
                  style={{
                    background: "#fff",
                    border: "1px solid #cbd5e1",
                    borderRadius: "4px",
                    padding: "5px 8px",
                    cursor: selectedFyIdx >= maxFyIdx ? "not-allowed" : "pointer",
                    fontSize: "12px",
                    color: selectedFyIdx >= maxFyIdx ? "#cbd5e1" : "#1e293b",
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
              onClick={() => selectedClient && fetchVatData(selectedClient, true)}
              disabled={loading || Boolean(savingSection)}
              title="Refresh data"
              style={{
                padding: "7px 14px",
                background: "#f8fafc",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                fontSize: "13px",
                fontWeight: 600,
                color: "#334155",
                cursor: loading || Boolean(savingSection) ? "not-allowed" : "pointer",
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
          </div>
        )}
      </div>

      {/* ── CLIENT SELECTOR (WHEN NO CLIENT SELECTED) ── */}
      {!selectedClient && !managedClient && (
        <EditClientSelector
          clients={allOutgoingsClients}
          onSelectClient={(c) => {
            setVatData(null);
            setError(null);
            setLoading(true);
            setShowOtherVatScheme(false);
            setSaveFeedback({});
            setSelectedClient(c);
            onSelectClient?.(c);
          }}
          loading={(allOutgoingsClients || []).length === 0}
          title="Select a client to view taxes:"
        />
      )}

      {/* ── ERROR BANNER ── */}
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
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            style={{ background: "none", border: "none", color: "#b91c1c", cursor: "pointer", fontSize: "14px" }}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      {/* ── SKELETON LOADING STATE ── */}
      {(selectedClient || managedClient) && loading && !vatData && !error && (
        <PmaVatSkeleton />
      )}

      {/* ── MAIN TAXES CONTENT ── */}
      {selectedClient && vatData && currentFy && (
        <>
          {/* ── 1. VAT SECTION ── */}
          <div style={{ marginBottom: "32px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px", flexWrap: "wrap" }}>
              <h2 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "#0f172a" }}>
                VAT
              </h2>
              {vatData.vatScheme && (
                <span
                  style={{
                    fontSize: "12px",
                    background: vatData.vatScheme === "Cash" ? "#f0fdf4" : "#eff6ff",
                    color: vatData.vatScheme === "Cash" ? "#166534" : "#1d4ed8",
                    padding: "2px 9px",
                    borderRadius: "12px",
                    fontWeight: 700,
                    border: `1px solid ${vatData.vatScheme === "Cash" ? "#bbf7d0" : "#bfdbfe"}`,
                  }}
                >
                  {vatData.vatScheme}
                </span>
              )}
            </div>

            {/* Settings summary strip + alternative scheme toggle */}
            <div
              style={{
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "8px",
                padding: "11px 18px",
                marginBottom: "18px",
                boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "12px 24px",
                fontSize: "13px",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "10px 24px" }}>
                <div>
                  <span style={{ color: "#64748b", fontWeight: 500 }}>VAT payment scheme: </span>
                  <span style={{ color: "#0f172a", fontWeight: 700 }}>{vatData.vatScheme}</span>
                  {isSysAdmin && (
                    <span style={{ color: "#94a3b8", fontSize: "11px", marginLeft: "5px" }}>(KeyInfo!B8)</span>
                  )}
                </div>

                <div>
                  <span style={{ color: "#64748b", fontWeight: 500 }}>VAT quarters: </span>
                  <span style={{ color: "#0f172a", fontWeight: 700 }}>{vatData.vatQuarters}</span>
                  {isSysAdmin && (
                    <span style={{ color: "#94a3b8", fontSize: "11px", marginLeft: "5px" }}>(KeyInfo!B6)</span>
                  )}
                </div>

                {fyDateRangeLabel && (
                  <div>
                    <span style={{ color: "#64748b", fontWeight: 500 }}>Financial year: </span>
                    <span style={{ color: "#0047AB", fontWeight: 700 }}>
                      {currentFy.label} ({fyDateRangeLabel})
                    </span>
                  </div>
                )}
              </div>

              {vatData.otherScheme && Array.isArray(vatData.otherSections) && vatData.otherSections.length > 0 && (
                <label
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "7px",
                    fontSize: "12.5px",
                    fontWeight: 600,
                    color: "#334155",
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={showOtherVatScheme}
                    onChange={(e) => setShowOtherVatScheme(e.target.checked)}
                    style={{ width: "15px", height: "15px", accentColor: "#0047AB", cursor: "pointer" }}
                  />
                  <span>Show {vatData.otherScheme.toLowerCase()} scheme VAT calculations</span>
                </label>
              )}
            </div>

            {/* Active scheme VAT tables */}
            {vatData.sections.map((section) => renderVatTable(section, "primary"))}

            {/* Other scheme VAT tables when checkbox checked */}
            {showOtherVatScheme && Array.isArray(vatData.otherSections) && vatData.otherSections.length > 0 && (
              <div style={{ marginTop: "24px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px" }}>
                  <h3 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "#334155" }}>
                    VAT calculations — {vatData.otherScheme} scheme
                  </h3>
                  <span
                    style={{
                      fontSize: "11px",
                      background: vatData.otherScheme === "Cash" ? "#f0fdf4" : "#eff6ff",
                      color: vatData.otherScheme === "Cash" ? "#166534" : "#1d4ed8",
                      padding: "2px 8px",
                      borderRadius: "12px",
                      fontWeight: 700,
                      border: `1px solid ${vatData.otherScheme === "Cash" ? "#bbf7d0" : "#bfdbfe"}`,
                    }}
                  >
                    {vatData.otherScheme}
                  </span>
                </div>
                {vatData.otherSections.map((section) => renderVatTable(section, "other"))}
              </div>
            )}
          </div>

          {/* ── 2. CORPORATION TAX SECTION ── */}
          {vatData.corpTax && Array.isArray(vatData.corpTax.sections) && vatData.corpTax.sections.length > 0 && (
            <div style={{ marginTop: "8px", paddingTop: "24px", borderTop: "1px solid #e2e8f0" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: "10px", marginBottom: "14px", flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "#0f172a" }}>
                  Corporation tax
                </h2>
                {fyDateRangeLabel && (
                  <span style={{ fontSize: "13px", fontWeight: 600, color: "#0047AB" }}>
                    {currentFy.label} ({fyDateRangeLabel})
                  </span>
                )}
              </div>

              {vatData.corpTax.sections.map((section) => renderCorpTaxSection(section))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
