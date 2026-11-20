import React, { useState, useEffect, useMemo, useCallback } from "react";
import Spinner from "./Spinner";
import EditClientSelector from "./EditClientSelector";
import { PmaVatSkeleton } from "./Skeleton";
import { useAuth } from "../hooks/useAuth";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { useFocusRevalidate } from "../hooks/useFocusRevalidate";
import { formatMoney as universalFormatMoney } from "../services/deepDiveHelper";

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
      if (cached?.data) return cached.data;
    }
    return null;
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedFyIdx, setSelectedFyIdx] = useState(() => vatData?.defaultFyIndex ?? 0);

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
          }
          return match;
        });
      }
    }
  }, [managedClient, initialClient, allOutgoingsClients]);

  const handleBackToClients = () => {
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
    if (cached?.data) {
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
          if (fresh?.data) {
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
        throw new Error(data.error || "Failed to load VAT data");
      }
      setVatData(data);
      if (!silent) {
        setSelectedFyIdx(data.defaultFyIndex ?? 0);
      }
      setCachedClientData(client.clientSheetId, "vat", data);
    } catch (err) {
      console.error("Failed to fetch VAT data:", err);
      if (!silent) setError(err.message || "Failed to load VAT data");
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
    canRevalidate: () => !loading,
    onRevalidate: () => {
      if (selectedClient?.clientSheetId) {
        fetchVatData(selectedClient, true, true);
      }
    },
  });

  const fyConfigs = vatData?.fyConfigs || [];
  const currentFy = fyConfigs[selectedFyIdx] || fyConfigs[0] || null;
  const maxFyIdx = fyConfigs.length > 0 ? fyConfigs.length - 1 : 0;

  const rawSymbol = vatData?.currencySymbol || selectedClient?.currencySymbol || "£";
  const currencySymbol = rawSymbol === "EUR" ? "€" : rawSymbol === "GBP" ? "£" : rawSymbol === "USD" ? "$" : rawSymbol;
  const thousandsSeparator = vatData?.thousandsSeparator || (currencySymbol === "€" ? "." : ",");

  const formatMoney = useCallback((val) => {
    const num = typeof val === "number" && !isNaN(val) ? val : 0;
    const normalized = Math.abs(num) < 0.005 ? 0 : num;
    return universalFormatMoney(normalized, 2, currencySymbol, thousandsSeparator);
  }, [currencySymbol, thousandsSeparator]);

  const fyDateRangeLabel = useMemo(() => {
    const months = currentFy?.monthCols || [];
    if (!months.length) return "";
    return `${months[0].label} – ${months[months.length - 1].label}`;
  }, [currentFy]);

  return (
    <div style={{ ...styles.container, maxWidth: "1440px", margin: "0 auto", padding: "20px 24px 48px" }}>
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
              <span>VAT</span>
              {selectedClient && vatData?.vatScheme && (
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
              disabled={loading}
              title="Refresh data"
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
            setSelectedClient(c);
            onSelectClient?.(c);
          }}
          loading={(allOutgoingsClients || []).length === 0}
          title="Select a client to view VAT:"
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

      {/* ── MAIN VAT CONTENT ── */}
      {selectedClient && vatData && currentFy && (
        <>
          {/* Settings summary strip */}
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

            <span
              style={{
                fontSize: "11px",
                fontWeight: 600,
                color: "#64748b",
                background: "#f1f5f9",
                border: "1px solid #e2e8f0",
                borderRadius: "999px",
                padding: "2px 10px",
              }}
            >
              Read-only
            </span>
          </div>

          {/* Section Tables: Confirmed only + Total */}
          {vatData.sections.map((section) => {
            const returnTotals = section.vatReturnTotalsByFy?.[currentFy.id] || {
              groups: [],
              isFullyAlignedFy: false,
              fyReturnSum: null,
            };
            const firstRowNum = section.rows[0]?.sheetRow;
            const lastRowNum = section.rows[section.rows.length - 1]?.sheetRow;

            return (
              <div
                key={section.key}
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
                  <h2 style={{ margin: 0, fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
                    {section.title}
                  </h2>
                  {isSysAdmin && firstRowNum && lastRowNum && (
                    <span style={{ fontSize: "11px", fontWeight: 600, color: "#64748b" }}>
                      VAT!Rows {firstRowNum - 1}–{lastRowNum}
                    </span>
                  )}
                </div>

                {/* Responsive monthly matrix table */}
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", textAlign: "right" }}>
                    <thead>
                      <tr style={{ background: "#f1f5f9", borderBottom: "1px solid #cbd5e1" }}>
                        <th
                          style={{
                            padding: "10px 14px",
                            textAlign: "left",
                            fontWeight: 700,
                            color: "#475569",
                            minWidth: "240px",
                            position: "sticky",
                            left: 0,
                            zIndex: 2,
                            background: "#f1f5f9",
                            borderRight: "1px solid #e2e8f0",
                          }}
                        >
                          Line item
                        </th>
                        {currentFy.monthCols.map((m) => (
                          <th
                            key={m.colIdx}
                            style={{
                              padding: "10px 10px",
                              fontWeight: 700,
                              color: "#475569",
                              minWidth: "86px",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {m.label}
                          </th>
                        ))}
                        <th
                          style={{
                            padding: "10px 14px",
                            fontWeight: 800,
                            color: "#0047AB",
                            background: "#eff6ff",
                            minWidth: "104px",
                            whiteSpace: "nowrap",
                            borderLeft: "1px solid #cbd5e1",
                          }}
                        >
                          {currentFy.totalHeaderLabel || `${currentFy.label} total`}
                        </th>
                      </tr>
                    </thead>

                    <tbody>
                      {section.rows.map((row) => {
                        const fyRow = row.fyData?.[currentFy.id] || { months: [], total: 0, isError: false };
                        const isTotal = Boolean(row.isTotalRow);
                        const rowBg = isTotal ? "#f8fafc" : "#ffffff";

                        return (
                          <tr
                            key={row.label + (row.sheetRow || "")}
                            style={{
                              background: rowBg,
                              borderTop: isTotal ? "1.5px solid #94a3b8" : "none",
                              borderBottom: isTotal ? "1.5px solid #cbd5e1" : "1px solid #f1f5f9",
                            }}
                          >
                            <td
                              style={{
                                padding: "9px 14px",
                                textAlign: "left",
                                fontWeight: isTotal ? 700 : 500,
                                color: isTotal ? "#0f172a" : "#334155",
                                position: "sticky",
                                left: 0,
                                zIndex: 1,
                                background: rowBg,
                                borderRight: "1px solid #e2e8f0",
                                whiteSpace: "nowrap",
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
                                    padding: "9px 10px",
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
                                padding: "9px 14px",
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
                              {fyRow.isError ? "Error" : formatMoney(fyRow.total)}
                            </td>
                          </tr>
                        );
                      })}

                      {/* VAT return totals row (Option A: directly under VAT owed to HMRC) */}
                      <tr
                        style={{
                          background: "#eff6ff",
                          borderTop: "1px solid #bfdbfe",
                        }}
                      >
                        <td
                          style={{
                            padding: "10px 14px",
                            textAlign: "left",
                            fontWeight: 700,
                            color: "#0047AB",
                            position: "sticky",
                            left: 0,
                            zIndex: 1,
                            background: "#eff6ff",
                            borderRight: "1px solid #bfdbfe",
                            whiteSpace: "nowrap",
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
                                padding: "9px 10px",
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
                                  fontSize: "12.5px",
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
                            padding: "10px 14px",
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
          })}
        </>
      )}
    </div>
  );
}
