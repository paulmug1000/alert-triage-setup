import React, { useEffect, useMemo, useState, useCallback } from "react";
import Spinner from "./Spinner";
import { useOptionalAppGlobals } from "../hooks/useAppGlobals";
import { sanitizeSpreadsheetTerms } from "../utils/helpers";

function getCurrencySymbol(currencyCode) {
  const code = String(currencyCode || "GBP").trim().toUpperCase();
  if (code === "GBP") return "£";
  if (code === "USD") return "$";
  if (code === "EUR") return "€";
  if (code === "AUD") return "A$";
  if (code === "CAD") return "C$";
  return `${code} `;
}

function formatMoney(amount, currencyCode = "GBP") {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sym = getCurrencySymbol(currencyCode);
  const formatted = abs.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-${sym}${formatted}` : `${sym}${formatted}`;
}

function formatGbp(amount) {
  return formatMoney(amount, "GBP");
}

function getStatusBadgeStyle(status) {
  const s = String(status || "").trim().toLowerCase();
  if (s === "paid" || s.includes("paid in full")) {
    return { backgroundColor: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0" };
  }
  if (s === "draft") {
    return { backgroundColor: "#ffedd5", color: "#9a3412", border: "1px solid #fed7aa" };
  }
  if (s === "authorised" || s === "authorized" || s === "sent" || s === "received" || s === "open") {
    return { backgroundColor: "#e0f2fe", color: "#0369a1", border: "1px solid #bae6fd" };
  }
  if (s.includes("part-paid") || s.includes("part paid") || s.includes("partpaid")) {
    return { backgroundColor: "#fef3c7", color: "#92400e", border: "1px solid #fde68a" };
  }
  if (s === "voided" || s === "deleted") {
    return { backgroundColor: "#fee2e2", color: "#991b1b", border: "1px solid #fecaca" };
  }
  return { backgroundColor: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0" };
}

function formatInvoiceTypeLabel(rawType) {
  const t = String(rawType || "").trim().toUpperCase();
  if (!t) return "";
  if (t === "ACCREC") return "Sales invoice";
  if (t === "ACCRECCREDIT" || t.includes("CREDIT")) return "Credit note";
  return rawType;
}

export function InvoiceDetailsContent({
  invoiceNo,
  masterSheetId,
  clientSheetId,
  clientName,
  fallbackSummary = null,
  initialLineItems = null,
  surface = "pma",
  isAdmin: propIsAdmin,
}) {
  const { allClientsMap } = useOptionalAppGlobals();
  const isAdmin = useMemo(() => {
    if (propIsAdmin !== undefined) return Boolean(propIsAdmin);
    if (typeof window !== "undefined" && window.__PULSE_SESSION_USER__) {
      const u = window.__PULSE_SESSION_USER__;
      return Boolean(!u.isReadOnly && (u.isAdmin || u.role === "Admin"));
    }
    return false;
  }, [propIsAdmin]);

  const resolvedIds = useMemo(() => {
    const cName = String(clientName || fallbackSummary?.tenantClientName || "").trim();
    const cNameLower = cName.toLowerCase();
    const directClientSheetId = String(clientSheetId || "").trim();
    let matchedKey = "";
    let matchedClient = null;
    if (allClientsMap && typeof allClientsMap === "object") {
      if (cName && allClientsMap[cName]) {
        matchedKey = cName;
        matchedClient = allClientsMap[cName];
      } else {
        for (const [k, v] of Object.entries(allClientsMap)) {
          if (!v || typeof v !== "object") continue;
          const vNameLower = String(v.clientName || k || "").trim().toLowerCase();
          if (cNameLower && (vNameLower === cNameLower || String(k).trim().toLowerCase() === cNameLower)) {
            matchedKey = v.clientName || k;
            matchedClient = v;
            break;
          }
          if (directClientSheetId && (v.clientSheetId === directClientSheetId || v.sheetId === directClientSheetId)) {
            matchedKey = v.clientName || k;
            matchedClient = v;
            break;
          }
        }
      }
    }
    return {
      clientName: cName || matchedClient?.clientName || matchedKey || "",
      masterSheetId: masterSheetId || matchedClient?.masterSheetId || "",
      clientSheetId: directClientSheetId || matchedClient?.clientSheetId || matchedClient?.sheetId || "",
    };
  }, [clientName, fallbackSummary?.tenantClientName, allClientsMap, masterSheetId, clientSheetId]);

  const cleanInvNo = useMemo(() => String(invoiceNo || "").replace(/^#/, "").trim(), [invoiceNo]);
  const isPortalSurface = surface === "portal";
  const hasLookupContext = isPortalSurface
    ? Boolean(cleanInvNo && resolvedIds.clientSheetId)
    : Boolean(cleanInvNo && (resolvedIds.masterSheetId || resolvedIds.clientSheetId || resolvedIds.clientName));

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => {
    let active = true;
    if (!hasLookupContext) {
      setLoading(false);
      setError("");
      setResult(null);
      return;
    }

    setLoading(true);
    setError("");

    const endpoint = isPortalSurface ? "/api/portal/invoice-details" : "/api/triage";
    const payload = isPortalSurface
      ? {
          clientSheetId: resolvedIds.clientSheetId,
          clientName: resolvedIds.clientName || undefined,
          invoiceNo: cleanInvNo,
        }
      : {
          action: "get_invoice_details",
          masterSheetId: resolvedIds.masterSheetId || undefined,
          clientSheetId: resolvedIds.clientSheetId || undefined,
          clientName: resolvedIds.clientName || undefined,
          invoiceNo: cleanInvNo,
        };

    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((res) => res.json())
      .then((data) => {
        if (!active) return;
        if (!data.success) {
          const msg = data.error || "Unable to load invoice details.";
          setError(isAdmin ? msg : sanitizeSpreadsheetTerms(msg));
          setResult(null);
        } else {
          setResult(data);
        }
      })
      .catch((err) => {
        if (!active) return;
        const msg = err?.message || "Unable to load invoice details.";
        setError(isAdmin ? msg : sanitizeSpreadsheetTerms(msg));
        setResult(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [hasLookupContext, isPortalSurface, cleanInvNo, resolvedIds.masterSheetId, resolvedIds.clientSheetId, resolvedIds.clientName, isAdmin]);

  const detail = result?.detail || null;
  const foundInAccounting = Boolean(result?.foundInAccounting && detail);

  const displayCurrency = String(detail?.currencyCode || fallbackSummary?.currencyCode || "GBP").toUpperCase();
  const isForeignCurrency = displayCurrency !== "GBP" && Number(detail?.currencyRate || 1) > 0;
  const displayInvNo = detail?.invoiceNumber || cleanInvNo;
  const displayStatus = detail?.status || fallbackSummary?.status || "";
  const displayTypeLabel = formatInvoiceTypeLabel(detail?.type);
  const displayContact = detail?.contactName || fallbackSummary?.client || fallbackSummary?.jobClient || "";
  const displayJobName = fallbackSummary?.jobName || "";
  const displayRef = detail?.reference || "";
  const displayIssueDate = detail?.issueDate || fallbackSummary?.sentDate || "";
  const displayDueDate = detail?.dueDate || fallbackSummary?.dueDate || "";
  const displayPaidDate = detail?.fullyPaidDate || fallbackSummary?.fullyPaidDate || "";
  const displayRechargedGbp =
    detail?.rechargedAmountGbp > 0
      ? detail.rechargedAmountGbp
      : Number(fallbackSummary?.rechargedAmountGbp || 0);

  const lineItems = useMemo(() => {
    if (Array.isArray(detail?.lineItems) && detail.lineItems.length > 0) {
      return detail.lineItems;
    }
    if (Array.isArray(initialLineItems) && initialLineItems.length > 0) {
      return initialLineItems;
    }
    return [];
  }, [detail, initialLineItems]);

  const lineItemsTotalGbp = useMemo(
    () =>
      Math.round(
        lineItems.reduce((sum, li) => sum + (Number(li?.amountGbp ?? li?.amount) || 0), 0) * 100
      ) / 100,
    [lineItems]
  );

  const lineItemsTotalNative = useMemo(
    () =>
      Math.round(
        lineItems.reduce((sum, li) => sum + (Number(li?.amount ?? li?.amountGbp) || 0), 0) * 100
      ) / 100,
    [lineItems]
  );

  const fallbackNet = fallbackSummary?.amount !== undefined && fallbackSummary?.amount !== "" ? Number(fallbackSummary.amount) : null;
  const fallbackGross = fallbackSummary?.grossAmount !== undefined && fallbackSummary?.grossAmount !== "" ? Number(fallbackSummary.grossAmount) : null;
  const fallbackVat = fallbackSummary?.vatAmount !== undefined && fallbackSummary?.vatAmount !== "" ? Number(fallbackSummary.vatAmount) : null;

  const summaryCards = foundInAccounting
    ? [
        {
          label: "Subtotal (excl. VAT)",
          value: formatMoney(detail.subTotal, displayCurrency),
          sub: isForeignCurrency ? `${formatGbp(detail.subTotalGbp)} GBP` : null,
        },
        {
          label: "VAT / tax",
          value: formatMoney(detail.taxTotal, displayCurrency),
          sub: isForeignCurrency ? `${formatGbp(detail.taxTotalGbp)} GBP` : null,
        },
        {
          label: "Total (incl. VAT)",
          value: formatMoney(detail.total, displayCurrency),
          sub: isForeignCurrency ? `${formatGbp(detail.totalGbp)} GBP` : null,
          highlight: true,
        },
        {
          label: "Amount paid",
          value: formatMoney(detail.amountPaid, displayCurrency),
          sub: isForeignCurrency ? `${formatGbp(detail.amountPaidGbp)} GBP` : null,
        },
        {
          label: "Amount due",
          value: formatMoney(detail.amountDue, displayCurrency),
          sub: isForeignCurrency ? `${formatGbp(detail.amountDueGbp)} GBP` : null,
          accent: detail.amountDue > 0.01 ? "#b45309" : "#15803d",
        },
      ]
    : [
        ...(Number.isFinite(fallbackNet)
          ? [{ label: "Net amount (excl. VAT)", value: formatGbp(fallbackNet), highlight: !Number.isFinite(fallbackGross) }]
          : []),
        ...(Number.isFinite(fallbackVat) ? [{ label: "VAT / tax", value: formatGbp(fallbackVat) }] : []),
        ...(Number.isFinite(fallbackGross) ? [{ label: "Total (incl. VAT)", value: formatGbp(fallbackGross), highlight: true }] : []),
      ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {/* Invoice header badges */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "8px",
          padding: "10px 12px",
          background: "#f8fafc",
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <span style={{ fontSize: "15px", fontWeight: "700", color: "#0f172a" }}>
            {displayInvNo ? `#${displayInvNo}` : "Invoice"}
          </span>
          {displayStatus && (
            <span
              style={{
                ...getStatusBadgeStyle(displayStatus),
                padding: "2px 8px",
                borderRadius: "12px",
                fontSize: "11px",
                fontWeight: "600",
              }}
            >
              {displayStatus}
            </span>
          )}
          {displayTypeLabel && (
            <span
              style={{
                padding: "2px 8px",
                borderRadius: "12px",
                fontSize: "11px",
                fontWeight: "600",
                background: "#f1f5f9",
                color: "#475569",
                border: "1px solid #cbd5e1",
              }}
            >
              {displayTypeLabel}
            </span>
          )}
          {isForeignCurrency && (
            <span
              style={{
                padding: "2px 8px",
                borderRadius: "12px",
                fontSize: "11px",
                fontWeight: "600",
                background: "#eef2ff",
                color: "#3730a3",
                border: "1px solid #c7d2fe",
              }}
            >
              {displayCurrency} (rate {Number(detail.currencyRate).toFixed(4)})
            </span>
          )}
        </div>
        {displayRechargedGbp > 0 && (
          <span
            style={{
              padding: "2px 8px",
              borderRadius: "12px",
              fontSize: "11px",
              fontWeight: "600",
              background: "#dbeafe",
              color: "#1d4ed8",
              border: "1px solid #bfdbfe",
            }}
          >
            Recharged expenses: {formatGbp(displayRechargedGbp)} (excl. VAT)
          </span>
        )}
      </div>

      {/* Loading / error notice */}
      {loading && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "10px 12px",
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            borderRadius: "8px",
            color: "#1e40af",
            fontSize: "12.5px",
            fontWeight: "600",
          }}
        >
          <Spinner size={14} color="#2563eb" />
          <span>Loading invoice details...</span>
        </div>
      )}

      {!loading && error && (
        <div
          style={{
            padding: "10px 12px",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            borderRadius: "8px",
            color: "#991b1b",
            fontSize: "12.5px",
          }}
        >
          {error}
        </div>
      )}

      {/* Key metadata */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(155px, 1fr))",
          gap: "10px",
          padding: "12px",
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
        }}
      >
        <div>
          <div style={{ fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "2px" }}>Contact</div>
          <div style={{ fontSize: "13px", fontWeight: "600", color: "#0f172a", wordBreak: "break-word" }}>
            {displayContact || "—"}
          </div>
        </div>
        {displayJobName && (
          <div>
            <div style={{ fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "2px" }}>Job</div>
            <div style={{ fontSize: "13px", fontWeight: "600", color: "#0f172a", wordBreak: "break-word" }}>
              {displayJobName}
            </div>
          </div>
        )}
        <div>
          <div style={{ fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "2px" }}>Reference</div>
          <div style={{ fontSize: "13px", color: "#334155", wordBreak: "break-word" }}>{displayRef || "—"}</div>
        </div>
        <div>
          <div style={{ fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "2px" }}>Issue date</div>
          <div style={{ fontSize: "13px", color: "#0f172a" }}>{displayIssueDate || "—"}</div>
        </div>
        <div>
          <div style={{ fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "2px" }}>Due date</div>
          <div style={{ fontSize: "13px", color: "#0f172a" }}>{displayDueDate || "—"}</div>
        </div>
        {displayPaidDate && (
          <div>
            <div style={{ fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "2px" }}>Paid date</div>
            <div style={{ fontSize: "13px", fontWeight: "600", color: "#15803d" }}>{displayPaidDate}</div>
          </div>
        )}
        {detail?.sentToContact && (
          <div>
            <div style={{ fontSize: "11px", fontWeight: "600", color: "#64748b", marginBottom: "2px" }}>Sent to contact</div>
            <div style={{ fontSize: "13px", color: "#334155" }}>
              {String(detail.sentToContact).toLowerCase() === "true"
                ? "Yes"
                : String(detail.sentToContact).toLowerCase() === "false"
                  ? "No"
                  : detail.sentToContact}
            </div>
          </div>
        )}
      </div>

      {/* Totals strip */}
      {summaryCards.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
            gap: "8px",
          }}
        >
          {summaryCards.map((card) => (
            <div
              key={card.label}
              style={{
                padding: "9px 10px",
                background: card.highlight ? "#f0f9ff" : "#f8fafc",
                border: `1px solid ${card.highlight ? "#bae6fd" : "#e2e8f0"}`,
                borderRadius: "7px",
              }}
            >
              <div style={{ fontSize: "10.5px", fontWeight: "600", color: "#64748b", marginBottom: "3px" }}>
                {card.label}
              </div>
              <div
                style={{
                  fontSize: "14px",
                  fontWeight: "700",
                  color: card.accent || (card.highlight ? "#0369a1" : "#0f172a"),
                }}
              >
                {card.value}
              </div>
              {card.sub && <div style={{ fontSize: "10.5px", color: "#64748b", marginTop: "2px" }}>{card.sub}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Line-by-line breakdown */}
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: "8px",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "10px 12px",
            background: "#f8fafc",
            borderBottom: "1px solid #e2e8f0",
          }}
        >
          <span style={{ fontSize: "12.5px", fontWeight: "700", color: "#0f172a" }}>
            Line-by-line breakdown
          </span>
          {lineItems.length > 0 && (
            <span style={{ fontSize: "11px", color: "#64748b" }}>
              {lineItems.length} {lineItems.length === 1 ? "line" : "lines"}
            </span>
          )}
        </div>

        {lineItems.length > 0 ? (
          <>
            <div style={{ maxHeight: "280px", overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", textAlign: "left" }}>
                <thead>
                  <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", color: "#64748b", fontSize: "11px" }}>
                    <th style={{ padding: "7px 10px", width: "28px", fontWeight: "600" }}>#</th>
                    <th style={{ padding: "7px 10px", fontWeight: "600" }}>Description</th>
                    <th style={{ padding: "7px 10px", fontWeight: "600" }}>Account / category</th>
                    <th style={{ padding: "7px 10px", textAlign: "right", fontWeight: "600", whiteSpace: "nowrap" }}>
                      Amount (excl. VAT)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((li, idx) => {
                    const lineAmtGbp = Number(li.amountGbp ?? li.amount) || 0;
                    const lineAmtNative = Number(li.amount ?? li.amountGbp) || 0;
                    const acctLabel =
                      li.accountCode && li.accountName
                        ? `${li.accountCode} · ${li.accountName}`
                        : li.accountName || li.accountCode || "—";
                    return (
                      <tr
                        key={idx}
                        style={{
                          borderBottom: idx === lineItems.length - 1 ? "none" : "1px solid #f1f5f9",
                          background: li.isRecharged ? "#f8fbff" : "#ffffff",
                        }}
                      >
                        <td style={{ padding: "8px 10px", color: "#94a3b8", verticalAlign: "top" }}>{idx + 1}</td>
                        <td style={{ padding: "8px 10px", color: "#0f172a", verticalAlign: "top", wordBreak: "break-word" }}>
                          <div style={{ fontWeight: "500" }}>{li.description || "(No description)"}</div>
                          {li.isRecharged && (
                            <span
                              style={{
                                display: "inline-block",
                                marginTop: "3px",
                                padding: "1px 6px",
                                borderRadius: "10px",
                                fontSize: "10px",
                                fontWeight: "600",
                                background: "#dbeafe",
                                color: "#1d4ed8",
                              }}
                            >
                              Recharged
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "8px 10px", color: "#64748b", verticalAlign: "top", fontSize: "11.5px" }}>
                          {acctLabel}
                        </td>
                        <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: "600", color: "#0f172a", verticalAlign: "top", whiteSpace: "nowrap" }}>
                          {isForeignCurrency && li.amount !== undefined ? (
                            <div>
                              <div>{formatMoney(lineAmtNative, displayCurrency)}</div>
                              <div style={{ fontSize: "10.5px", color: "#64748b", fontWeight: "500" }}>
                                {formatGbp(lineAmtGbp)} GBP
                              </div>
                            </div>
                          ) : (
                            formatGbp(lineAmtGbp)
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ background: "#f8fafc", borderTop: "1px solid #e2e8f0" }}>
                    <td colSpan={3} style={{ padding: "8px 10px", fontWeight: "700", color: "#334155", textAlign: "right" }}>
                      Line items total (excl. VAT)
                    </td>
                    <td style={{ padding: "8px 10px", textAlign: "right", fontWeight: "700", color: "#0f172a", whiteSpace: "nowrap" }}>
                      {isForeignCurrency ? (
                        <div>
                          <div>{formatMoney(lineItemsTotalNative, displayCurrency)}</div>
                          <div style={{ fontSize: "10.5px", color: "#64748b", fontWeight: "600" }}>
                            {formatGbp(lineItemsTotalGbp)} GBP
                          </div>
                        </div>
                      ) : (
                        formatGbp(lineItemsTotalGbp)
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {detail?.lineBreakdownTruncated && (
              <div style={{ padding: "6px 12px", background: "#f8fafc", borderTop: "1px solid #e2e8f0", fontSize: "11px", color: "#64748b" }}>
                Showing the first 25 line items for this invoice.
              </div>
            )}
          </>
        ) : !loading ? (
          <div style={{ padding: "18px 14px", fontSize: "12.5px", color: "#64748b", textAlign: "center", lineHeight: "1.5" }}>
            {foundInAccounting
              ? "Line-by-line breakdown is not available for this invoice yet. It will populate after the next accounting sync."
              : hasLookupContext
                ? "No additional accounting breakdown was found for this invoice. It may be a manual entry or outside the accounting sync window."
                : "Accounting sync details are not available for this invoice."}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function InvoiceDetailsModal({
  isOpen,
  target,
  invoicesClient,
  surface = "pma",
  isAdmin,
  onClose,
}) {
  const close = useCallback(() => {
    if (typeof onClose === "function") onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isOpen, close]);

  if (!isOpen || !target) return null;

  const invNo = String(target.invoiceNo || target.ref || "").replace(/^#/, "").trim();
  const effectiveSurface = target.surface || surface || "pma";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        zIndex: 10100,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: "12px",
          padding: "24px",
          width: "min(94vw, 680px)",
          maxHeight: "88vh",
          overflowY: "auto",
          boxShadow: "0 20px 60px rgba(0,0,0,0.3)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700", color: "#1e293b" }}>
              Invoice details{invNo ? ` · #${invNo}` : ""}
            </h3>
            {target.fallbackSummary?.client && (
              <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                Client: <strong>{target.fallbackSummary.client}</strong>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            style={{ background: "none", border: "none", fontSize: "22px", cursor: "pointer", color: "#94a3b8" }}
          >
            ×
          </button>
        </div>

        <InvoiceDetailsContent
          invoiceNo={invNo}
          masterSheetId={target.masterSheetId || invoicesClient?.masterSheetId}
          clientSheetId={target.clientSheetId || invoicesClient?.clientSheetId}
          clientName={target.clientName || invoicesClient?.clientName || invoicesClient?.name}
          fallbackSummary={target.fallbackSummary}
          initialLineItems={target.initialLineItems}
          surface={effectiveSurface}
          isAdmin={isAdmin}
        />

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "18px" }}>
          <button
            type="button"
            onClick={close}
            style={{
              padding: "8px 18px",
              background: "#f1f5f9",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "13px",
              fontWeight: "600",
              color: "#334155",
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
