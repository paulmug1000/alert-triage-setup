import React, { useEffect, useRef, useState } from "react";
import Spinner from "./Spinner";
import { useActivity } from "../hooks/useActivity";

/**
 * CardScrollContainer:
 * Solves the "scroll trap" by using an 800ms hover-intent timer.
 * - While cursor is moving across cards: overflow is hidden so mousewheel scrolls page unimpeded.
 * - If cursor pauses over card >= 800ms: activates inner scroll.
 * - Clicking inside card activates immediately.
 * - overscrollBehavior: auto ensures no trapped scroll lock at top or bottom.
 */
function CardScrollContainer({ children, hasEvents }) {
  const [isActive, setIsActive] = useState(false);
  const hoverTimerRef = useRef(null);

  const handleMouseEnter = () => {
    if (!hasEvents) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setIsActive(true);
    }, 800);
  };

  const handleMouseLeave = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setIsActive(false);
  };

  const handleClick = () => {
    if (!hasEvents) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setIsActive(true);
  };

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  return (
    <div
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      style={{
        maxHeight: "360px",
        overflowY: isActive ? "auto" : "hidden",
        overscrollBehavior: "auto",
        flex: 1,
        position: "relative"
      }}
    >
      {children}
    </div>
  );
}

export default function ActivityView({
  automationCommanderSheetId,
  allOutgoingsClients = [],
  styles
}) {
  const {
    activityData,
    selectedClient,
    setSelectedClient,
    includeRoutine,
    setIncludeRoutine,
    isLoading,
    isRefreshing,
    error,
    expandedEvents,
    toggleExpand,
    loadActivity
  } = useActivity(automationCommanderSheetId, allOutgoingsClients);

  // SWR: Instant render from cache + automatic live background revalidation from Google Sheets
  const revalidatedRef = useRef(false);
  useEffect(() => {
    if (!revalidatedRef.current) {
      revalidatedRef.current = true;
      const hasCached = (activityData?.allEvents?.length > 0) || (Object.keys(activityData?.clients || {}).length > 0);
      if (hasCached) {
        // Cached data is already rendering on screen (via localStorage).
        // Trigger live automatic background refresh against Google Sheets!
        loadActivity({ forceRefresh: true });
      } else {
        // First visit on this device: load Redis snapshot first (<50ms), then revalidate in background
        loadActivity({ forceRefresh: false }).then(() => {
          loadActivity({ forceRefresh: true });
        });
      }
    }
  }, [loadActivity, activityData]);

  // Handle client change
  const handleClientChange = (e) => {
    const val = e.target.value;
    setSelectedClient(val);
    loadActivity({ clientName: val, includeRoutine });
  };

  // Handle routine toggle
  const handleRoutineToggle = (e) => {
    const checked = e.target.checked;
    setIncludeRoutine(checked);
    loadActivity({ clientName: selectedClient, includeRoutine: checked });
  };

  // Format last synced time from actual data timestamp
  const formatCachedTime = (isoString) => {
    if (!isoString) return null;
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return null;
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const timeStr = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    if (isToday) return `Today ${timeStr}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${timeStr}`;
    const dayMonth = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    return `${dayMonth}, ${timeStr}`;
  };

  const lastRefreshStr = formatCachedTime(activityData.cachedAt);

  // Helper for normalizing action badge text to concise labels (e.g., "New", "Updated", "Paid")
  const getActionBadgeLabel = (text = "", defaultLabel = "Updated") => {
    const t = String(text).toLowerCase();
    if (t.includes("new")) return "New";
    if (t.includes("paid")) return "Paid";
    if (t.includes("gap")) return "Gap";
    if (t.includes("match")) return "Matched";
    if (t.includes("vat")) return "VAT Updated";
    if (t.includes("overdue")) return "Overdue";
    if (t.includes("manual")) return "Manual";
    if (t.includes("date")) return "Date Moved";
    if (t.includes("update") || t.includes("adjust") || t.includes("import")) return "Updated";
    return text || defaultLabel;
  };

  // Helper for action badge colors
  const getActionBadgeStyle = (actionType = "", text = "") => {
    const t = (text + " " + actionType).toLowerCase();
    if (t.includes("paid")) {
      return { bg: "#dcfce7", color: "#166534", border: "#bbf7d0" };
    }
    if (t.includes("overdue") || t.includes("sent (was")) {
      return { bg: "#fee2e2", color: "#991b1b", border: "#fecaca" };
    }
    if (t.includes("new")) {
      return { bg: "#e0f2fe", color: "#0369a1", border: "#bae6fd" };
    }
    if (t.includes("vat")) {
      return { bg: "#e0e7ff", color: "#3730a3", border: "#c7d2fe" };
    }
    if (t.includes("match") || t.includes("created")) {
      return { bg: "#f0fdf4", color: "#15803d", border: "#bbf7d0" };
    }
    if (t.includes("manual") || t.includes("date")) {
      return { bg: "#fef3c7", color: "#92400e", border: "#fde68a" };
    }
    return { bg: "#f3e8ff", color: "#6b21a8", border: "#e9d5ff" };
  };

  const formatCategory = (cat = "") => {
    const c = String(cat).trim();
    if (!c) return "";
    if (c.toUpperCase() === "CRM") return "CRM";
    return c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
  };

  // Render Category Badge:
  // - No icon
  // - Description: "Invoices (auto)", "Job (user)", etc.
  // - Exact spreadsheet highlight colours:
  //     Expenses (auto): Soft pink/peach (#feebeb)
  //     CRM (auto): Soft periwinkle/blue (#e8f0fe)
  //     Invoices (auto): Soft mint green (#e6f4ea)
  //     User items: Light yellow (#fef3c7)
  // - Text colour: Always black (#000000)
  const renderBadge = (ev) => {
    const isUser = ev.source === "user" || ["JOB", "SESSION", "OUTGOINGS", "SALARIES"].includes(ev.category);
    let bg = "#f1f5f9";
    let border = "#e2e8f0";

    if (isUser) {
      bg = "#fef3c7";
      border = "#fde68a";
    } else {
      if (ev.category === "INVOICES") {
        bg = "#e6f4ea";
        border = "#ceead6";
      } else if (ev.category === "CRM") {
        bg = "#e8f0fe";
        border = "#d2e3fc";
      } else if (ev.category === "EXPENSES") {
        bg = "#feebeb";
        border = "#fad2cf";
      } else {
        bg = "#f1f5f9";
        border = "#e2e8f0";
      }
    }

    const categoryTitle = formatCategory(ev.category);
    const sourceText = (ev.source || (isUser ? "user" : "auto")).toLowerCase();
    const badgeLabel = `${categoryTitle} (${sourceText})`;

    return (
      <span style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: "4px",
        fontSize: "11px",
        fontWeight: "600",
        background: bg,
        border: `1px solid ${border}`,
        color: "#000000",
        letterSpacing: "0.2px"
      }}>
        {badgeLabel}
      </span>
    );
  };

  // Render Details Drawer
  const renderEventDetails = (ev) => {
    const details = ev.structuredDetails || {};

    // Invoices segmentation (handles both new structured keys and legacy cached events)
    const accountingInvoices = details.accountingInvoices || 
      (Array.isArray(details.invoices) ? details.invoices.filter(inv => !inv.sheet && !inv.slot && !inv.row) : []);
    const matchedInvoices = details.matchedInvoices || 
      (Array.isArray(details.invoices) ? details.invoices.filter(inv => inv.sheet || inv.slot || inv.row) : []);
    const invoiceGaps = Array.isArray(details.invoiceGaps) ? details.invoiceGaps : [];

    // Expenses segmentation (handles both new structured keys and legacy cached events)
    const accountingExpenses = details.accountingExpenses || 
      (Array.isArray(details.expenses) ? details.expenses.filter(e => !e.sheet) : []);
    const matchedExpenses = details.matchedExpenses || 
      (Array.isArray(details.expenses) ? details.expenses.filter(e => e.sheet && !e.statusType?.includes("manual") && !e.action?.toLowerCase().includes("manual")) : []);
    const manualAdjustments = details.manualAdjustments || 
      (Array.isArray(details.expenses) ? details.expenses.filter(e => e.sheet && (e.statusType?.includes("manual") || e.action?.toLowerCase().includes("manual") || e.action === "Date Moved")) : []);

    const hasAccountingInvoices = accountingInvoices.length > 0;
    const hasMatchedInvoices = matchedInvoices.length > 0;
    const hasInvoiceGaps = invoiceGaps.length > 0;

    const hasAccountingExpenses = accountingExpenses.length > 0;
    const hasMatchedExpenses = matchedExpenses.length > 0;
    const hasManualAdjustments = manualAdjustments.length > 0;

    const hasOpportunities = Array.isArray(details.opportunities) && details.opportunities.length > 0;
    const hasCreatedJobs = Array.isArray(details.createdJobs) && details.createdJobs.length > 0;
    const hasSkippedJobs = Array.isArray(details.skippedJobs) && details.skippedJobs.length > 0;
    const hasViews = Array.isArray(details.viewsLog) && details.viewsLog.length > 0;
    const hasChanges = details.changes && typeof details.changes === "object";

    return (
      <div style={{
        marginTop: "10px",
        padding: "12px",
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: "6px",
        fontSize: "12px",
        color: "#334155"
      }}>
        {/* INVOICE GAPS (Clean Bullet Cards) */}
        {hasInvoiceGaps && (
          <div style={{ marginBottom: "14px" }}>
            <div style={{ fontWeight: "600", color: "#1e293b", marginBottom: "8px" }}>
              {invoiceGaps.length} invoice gap{invoiceGaps.length > 1 ? "s" : ""} created / adjusted in Pulse:
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {invoiceGaps.map((gap, i) => (
                <div key={i} style={{
                  background: "#ffffff",
                  border: "1px solid #e2e8f0",
                  borderRadius: "6px",
                  padding: "10px 12px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "8px"
                }}>
                  <div>
                    <div style={{ fontWeight: "600", color: "#0f172a", fontSize: "12.5px" }}>
                      {gap.client || "Client"} {gap.jobName ? <span style={{ color: "#64748b", fontWeight: "normal" }}>• {gap.jobName}</span> : null}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "4px", flexWrap: "wrap" }}>
                      <span style={{
                        padding: "1px 6px",
                        borderRadius: "3px",
                        background: "#f1f5f9",
                        color: "#475569",
                        fontSize: "10.5px",
                        fontWeight: "600"
                      }}>
                        {gap.invoiceType || "Invoice"}
                      </span>
                      {gap.slot && (
                        <span style={{
                          padding: "1px 6px",
                          borderRadius: "3px",
                          background: "#e0f2fe",
                          color: "#0369a1",
                          fontSize: "10.5px"
                        }}>
                          {gap.slot} {gap.row ? `(Row ${gap.row})` : ""}
                        </span>
                      )}
                      <span style={{
                        padding: "1px 6px",
                        borderRadius: "3px",
                        background: "#fef3c7",
                        color: "#92400e",
                        fontSize: "10.5px"
                      }}>
                        {gap.sheet || "Pipeline"}
                      </span>
                      {gap.rawChanges && (
                        <span style={{ fontSize: "10.5px", color: "#64748b", fontStyle: "italic" }}>
                          {gap.rawChanges}
                        </span>
                      )}
                    </div>
                  </div>
                  {gap.amount && (
                    <div style={{
                      fontSize: "13.5px",
                      fontWeight: "700",
                      color: "#0f766e"
                    }}>
                      {gap.amount}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* INVOICES TABLE 1: ACCOUNTING TOOL DOWNLOAD */}
        {hasAccountingInvoices && (
          <div style={{ marginBottom: "14px" }}>
            <div style={{ fontWeight: "600", color: "#1e293b", marginBottom: "8px" }}>
              {accountingInvoices.length} invoice{accountingInvoices.length > 1 ? "s" : ""} adjusted / imported from accounting tool:
            </div>
            <div style={{ overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: "6px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px", background: "#fff" }}>
                <thead>
                  <tr style={{ background: "#f1f5f9", textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                    <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569", width: "95px" }}>Invoice #</th>
                    <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569" }}>Client / Job & Status Details</th>
                  </tr>
                </thead>
                <tbody>
                  {accountingInvoices.map((inv, i) => {
                    const actionText = inv.action || inv.status || "Updated";
                    const badgeLabel = getActionBadgeLabel(actionText, "Updated");
                    const bStyle = getActionBadgeStyle(inv.statusType, actionText);
                    return (
                      <tr key={i} style={{ borderBottom: i < accountingInvoices.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                        <td style={{ padding: "8px 10px", verticalAlign: "top", width: "95px" }}>
                          <div style={{ fontWeight: "700", color: "#1e293b", fontFamily: "monospace", fontSize: "11.5px" }}>
                            {inv.invoiceNumber || "—"}
                          </div>
                          <div style={{ marginTop: "4px" }}>
                            <span style={{
                              display: "inline-block",
                              padding: "2px 6px",
                              borderRadius: "4px",
                              fontSize: "10px",
                              fontWeight: "600",
                              background: bStyle.bg,
                              color: bStyle.color,
                              border: `1px solid ${bStyle.border}`,
                              lineHeight: "1.3"
                            }}>
                              {badgeLabel}
                            </span>
                          </div>
                        </td>
                        <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px" }}>
                            <strong style={{ color: "#0f172a", fontSize: "12px" }}>
                              {inv.clientName || inv.description || "Invoice"}
                            </strong>
                            {inv.jobName && (
                              <span style={{ color: "#64748b", fontSize: "11.5px" }}>• {inv.jobName}</span>
                            )}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px", marginTop: "5px" }}>
                            {inv.amount && inv.amount !== "—" && (
                              <span style={{
                                padding: "2px 7px",
                                borderRadius: "4px",
                                fontSize: "11px",
                                fontWeight: "700",
                                background: "#f0fdf4",
                                color: "#0f766e",
                                border: "1px solid #bbf7d0"
                              }}>
                                {inv.amount}
                              </span>
                            )}
                            {Array.isArray(inv.dates) && inv.dates.map((d, dIdx) => (
                              <span key={dIdx} style={{
                                padding: "2px 6px",
                                borderRadius: "3px",
                                fontSize: "10.5px",
                                fontWeight: "500",
                                background: "#f8fafc",
                                border: "1px solid #e2e8f0",
                                color: "#475569"
                              }}>
                                {d}
                              </span>
                            ))}
                          </div>
                          {inv.rawChanges && inv.rawChanges !== inv.status && !inv.rawChanges.startsWith("Amount:") && (
                            <div style={{ fontSize: "10.5px", color: "#64748b", marginTop: "4px", fontStyle: "italic" }}>
                              {inv.rawChanges}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* INVOICES TABLE 2: PULSE MATCHED & UPDATED */}
        {hasMatchedInvoices && (
          <div style={{ marginBottom: "14px" }}>
            <div style={{ fontWeight: "600", color: "#1e293b", marginBottom: "8px" }}>
              {matchedInvoices.length} invoice{matchedInvoices.length > 1 ? "s" : ""} matched & updated in Pulse:
            </div>
            <div style={{ overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: "6px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px", background: "#fff" }}>
                <thead>
                  <tr style={{ background: "#f1f5f9", textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                    <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569", width: "95px" }}>Invoice #</th>
                    <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569" }}>Client / Job & Status Details</th>
                  </tr>
                </thead>
                <tbody>
                  {matchedInvoices.map((inv, i) => {
                    const actionText = inv.action || inv.status || "Updated in Pulse";
                    const badgeLabel = getActionBadgeLabel(actionText, "Matched");
                    const bStyle = getActionBadgeStyle(inv.statusType, actionText);
                    return (
                      <tr key={i} style={{ borderBottom: i < matchedInvoices.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                        <td style={{ padding: "8px 10px", verticalAlign: "top", width: "95px" }}>
                          <div style={{ fontWeight: "700", color: "#1e293b", fontFamily: "monospace", fontSize: "11.5px" }}>
                            {inv.invoiceNumber || "—"}
                          </div>
                          <div style={{ marginTop: "4px" }}>
                            <span style={{
                              display: "inline-block",
                              padding: "2px 6px",
                              borderRadius: "4px",
                              fontSize: "10px",
                              fontWeight: "600",
                              background: bStyle.bg,
                              color: bStyle.color,
                              border: `1px solid ${bStyle.border}`,
                              lineHeight: "1.3"
                            }}>
                              {badgeLabel}
                            </span>
                          </div>
                        </td>
                        <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px" }}>
                            <strong style={{ color: "#0f172a", fontSize: "12px" }}>
                              {inv.clientName || inv.description || "Invoice"}
                            </strong>
                            {inv.jobName && (
                              <span style={{ color: "#64748b", fontSize: "11.5px" }}>• {inv.jobName}</span>
                            )}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px", marginTop: "5px" }}>
                            {(inv.sheet || inv.slot) && (
                              <span style={{
                                padding: "1px 6px",
                                borderRadius: "3px",
                                background: "#fef3c7",
                                color: "#92400e",
                                fontSize: "10.5px",
                                fontWeight: "600"
                              }}>
                                {inv.sheet || "Confirmed"}{inv.slot ? ` • ${inv.slot}` : ""}{inv.row ? ` (Row ${inv.row})` : ""}
                              </span>
                            )}
                            {inv.amount && inv.amount !== "—" && (
                              <span style={{
                                padding: "2px 7px",
                                borderRadius: "4px",
                                fontSize: "11px",
                                fontWeight: "700",
                                background: "#f0fdf4",
                                color: "#0f766e",
                                border: "1px solid #bbf7d0"
                              }}>
                                {inv.amount}
                              </span>
                            )}
                            {Array.isArray(inv.dates) && inv.dates.map((d, dIdx) => (
                              <span key={dIdx} style={{
                                padding: "2px 6px",
                                borderRadius: "3px",
                                fontSize: "10.5px",
                                fontWeight: "500",
                                background: "#f8fafc",
                                border: "1px solid #e2e8f0",
                                color: "#475569"
                              }}>
                                {d}
                              </span>
                            ))}
                          </div>
                          {inv.rawChanges && inv.rawChanges !== inv.status && (
                            <div style={{ fontSize: "10.5px", color: "#64748b", marginTop: "4px", fontStyle: "italic" }}>
                              {inv.rawChanges}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* EXPENSES TABLE 1: ACCOUNTING TOOL DOWNLOAD */}
        {hasAccountingExpenses && (
          <div style={{ marginBottom: "14px" }}>
            <div style={{ fontWeight: "600", color: "#1e293b", marginBottom: "8px" }}>
              {accountingExpenses.length} expense{accountingExpenses.length > 1 ? "s" : ""} adjusted / imported from accounting tool:
            </div>
            <div style={{ overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: "6px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px", background: "#fff" }}>
                <thead>
                  <tr style={{ background: "#f1f5f9", textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                    <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569", width: "105px" }}>Supplier / Ref</th>
                    <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569" }}>Supplier / Job & Status Details</th>
                  </tr>
                </thead>
                <tbody>
                  {accountingExpenses.map((exp, i) => {
                    const actionText = exp.action || exp.status || "Updated";
                    const badgeLabel = getActionBadgeLabel(actionText, "Updated");
                    const bStyle = getActionBadgeStyle(exp.statusType, actionText);
                    return (
                      <tr key={i} style={{ borderBottom: i < accountingExpenses.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                        <td style={{ padding: "8px 10px", verticalAlign: "top", width: "105px" }}>
                          <div style={{ fontWeight: "700", color: "#1e293b", fontFamily: "monospace", fontSize: "11.5px" }}>
                            {exp.ref || exp.supplier || "—"}
                          </div>
                          <div style={{ marginTop: "4px" }}>
                            <span style={{
                              display: "inline-block",
                              padding: "2px 6px",
                              borderRadius: "4px",
                              fontSize: "10px",
                              fontWeight: "600",
                              background: bStyle.bg,
                              color: bStyle.color,
                              border: `1px solid ${bStyle.border}`,
                              lineHeight: "1.3"
                            }}>
                              {badgeLabel}
                            </span>
                          </div>
                        </td>
                        <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px" }}>
                            <strong style={{ color: "#0f172a", fontSize: "12px" }}>
                              {exp.supplier || exp.description || "Expense"}
                            </strong>
                            {exp.jobOrRef && (
                              <span style={{ color: "#64748b", fontSize: "11.5px" }}>• {exp.jobOrRef}</span>
                            )}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px", marginTop: "5px" }}>
                            {exp.amount && exp.amount !== "—" && (
                              <span style={{
                                padding: "2px 7px",
                                borderRadius: "4px",
                                fontSize: "11px",
                                fontWeight: "700",
                                background: "#f0fdf4",
                                color: "#0f766e",
                                border: "1px solid #bbf7d0"
                              }}>
                                {exp.amount}
                              </span>
                            )}
                            {Array.isArray(exp.dates) && exp.dates.map((d, dIdx) => (
                              <span key={dIdx} style={{
                                padding: "2px 6px",
                                borderRadius: "3px",
                                fontSize: "10.5px",
                                fontWeight: "500",
                                background: "#f8fafc",
                                border: "1px solid #e2e8f0",
                                color: "#475569"
                              }}>
                                {d}
                              </span>
                            ))}
                          </div>
                          {exp.rawChanges && exp.rawChanges !== exp.status && (
                            <div style={{ fontSize: "10.5px", color: "#64748b", marginTop: "4px", fontStyle: "italic" }}>
                              {exp.rawChanges}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* EXPENSES TABLE 2: PULSE MATCHED & UPDATED */}
        {hasMatchedExpenses && (
          <div style={{ marginBottom: "14px" }}>
            <div style={{ fontWeight: "600", color: "#1e293b", marginBottom: "8px" }}>
              {matchedExpenses.length} expense{matchedExpenses.length > 1 ? "s" : ""} matched & updated in Pulse:
            </div>
            <div style={{ overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: "6px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px", background: "#fff" }}>
                <thead>
                  <tr style={{ background: "#f1f5f9", textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                    <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569", width: "110px" }}>Supplier / Item</th>
                    <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569" }}>Location & Status Details</th>
                  </tr>
                </thead>
                <tbody>
                  {matchedExpenses.map((exp, i) => {
                    const actionText = exp.action || exp.status || "Matched in Pulse";
                    const badgeLabel = getActionBadgeLabel(actionText, "Matched");
                    const bStyle = getActionBadgeStyle(exp.statusType, actionText);
                    return (
                      <tr key={i} style={{ borderBottom: i < matchedExpenses.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                        <td style={{ padding: "8px 10px", verticalAlign: "top", width: "110px" }}>
                          <div style={{ fontWeight: "700", color: "#1e293b", fontSize: "11.5px" }}>
                            {exp.supplier || exp.description || "—"}
                          </div>
                          <div style={{ marginTop: "4px" }}>
                            <span style={{
                              display: "inline-block",
                              padding: "2px 6px",
                              borderRadius: "4px",
                              fontSize: "10px",
                              fontWeight: "600",
                              background: bStyle.bg,
                              color: bStyle.color,
                              border: `1px solid ${bStyle.border}`,
                              lineHeight: "1.3"
                            }}>
                              {badgeLabel}
                            </span>
                          </div>
                        </td>
                        <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                            {exp.sheet && (
                              <span style={{
                                padding: "1px 6px",
                                borderRadius: "3px",
                                background: "#fef3c7",
                                color: "#92400e",
                                fontSize: "10.5px",
                                fontWeight: "600"
                              }}>
                                {exp.sheet}{exp.slot ? ` • ${exp.slot}` : ""}{exp.row && !String(exp.row).includes("-") ? ` (Row ${exp.row})` : ""}
                              </span>
                            )}
                            {exp.amount && exp.amount !== "—" && (
                              <span style={{
                                padding: "2px 7px",
                                borderRadius: "4px",
                                fontSize: "11px",
                                fontWeight: "700",
                                background: "#f0fdf4",
                                color: "#0f766e",
                                border: "1px solid #bbf7d0"
                              }}>
                                {exp.amount}
                              </span>
                            )}
                          </div>
                          {exp.rawChanges && exp.rawChanges !== exp.status && (
                            <div style={{ fontSize: "10.5px", color: "#64748b", marginTop: "4px", fontStyle: "italic" }}>
                              {exp.rawChanges}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* EXPENSES TABLE 3: MANUAL EXPENSE ENTRIES & GAPS ADJUSTED IN OUTGOINGS */}
        {hasManualAdjustments && (
          <div style={{ marginBottom: "14px" }}>
            <div style={{ fontWeight: "600", color: "#1e293b", marginBottom: "8px" }}>
              {manualAdjustments.length} manual entry / gap adjustment{manualAdjustments.length > 1 ? "s" : ""} in Pulse:
            </div>
            <div style={{ overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: "6px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px", background: "#fff" }}>
                <thead>
                  <tr style={{ background: "#f1f5f9", textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                    <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569", width: "115px" }}>Entry / Description</th>
                    <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569" }}>Location & Amount Details</th>
                  </tr>
                </thead>
                <tbody>
                  {manualAdjustments.map((exp, i) => {
                    const actionText = exp.action || exp.status || "Manual Adjusted";
                    const badgeLabel = getActionBadgeLabel(actionText, "Manual");
                    const bStyle = getActionBadgeStyle(exp.statusType, actionText);
                    return (
                      <tr key={i} style={{ borderBottom: i < manualAdjustments.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                        <td style={{ padding: "8px 10px", verticalAlign: "top", width: "115px" }}>
                          <div style={{ fontWeight: "600", color: "#0f172a", fontSize: "11.5px" }}>
                            {exp.entry || exp.supplier || exp.description || "Manual Entry"}
                          </div>
                          <div style={{ marginTop: "4px" }}>
                            <span style={{
                              display: "inline-block",
                              padding: "2px 6px",
                              borderRadius: "4px",
                              fontSize: "10px",
                              fontWeight: "600",
                              background: bStyle.bg,
                              color: bStyle.color,
                              border: `1px solid ${bStyle.border}`,
                              lineHeight: "1.3"
                            }}>
                              {badgeLabel}
                            </span>
                          </div>
                        </td>
                        <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px" }}>
                            <span style={{
                              padding: "1px 6px",
                              borderRadius: "3px",
                              background: "#fef3c7",
                              color: "#92400e",
                              fontSize: "10.5px",
                              fontWeight: "600"
                            }}>
                              {exp.sheet || "Outgoings"}{exp.slot ? ` • ${exp.slot}` : ""}{exp.row && !String(exp.row).includes("-") ? ` (Row ${exp.row})` : ""}
                            </span>
                            {exp.amount && exp.amount !== "—" && (
                              <span style={{
                                padding: "2px 7px",
                                borderRadius: "4px",
                                fontSize: "11px",
                                fontWeight: "700",
                                background: "#f0fdf4",
                                color: "#0f766e",
                                border: "1px solid #bbf7d0"
                              }}>
                                {exp.amount}
                              </span>
                            )}
                            {Array.isArray(exp.dates) && exp.dates.map((d, dIdx) => (
                              <span key={dIdx} style={{
                                padding: "2px 6px",
                                borderRadius: "3px",
                                fontSize: "10.5px",
                                fontWeight: "500",
                                background: "#f8fafc",
                                border: "1px solid #e2e8f0",
                                color: "#475569"
                              }}>
                                {d}
                              </span>
                            ))}
                          </div>
                          {exp.rawChanges && exp.rawChanges !== exp.status && (
                            <div style={{ fontSize: "10.5px", color: "#64748b", marginTop: "4px", fontStyle: "italic" }}>
                              {exp.rawChanges}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* CRM CREATED CONFIRMED JOBS */}
        {hasCreatedJobs && (
          <div style={{ marginBottom: "12px" }}>
            <div style={{ fontWeight: "600", color: "#1e293b", marginBottom: "8px" }}>
              Created Confirmed Jobs ({details.createdJobs.length}):
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {details.createdJobs.map((cj, i) => (
                <div key={i} style={{
                  background: "#ffffff",
                  border: "1px solid #e2e8f0",
                  borderRadius: "6px",
                  padding: "8px 12px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center"
                }}>
                  <div>
                    <strong style={{ color: "#0f172a", fontSize: "12px" }}>{cj.client}</strong>
                    <span style={{ color: "#64748b", marginLeft: "4px" }}>• {cj.jobName}</span>
                  </div>
                  <span style={{
                    padding: "1px 6px",
                    borderRadius: "3px",
                    background: "#dcfce7",
                    color: "#166534",
                    fontSize: "10.5px",
                    fontWeight: "600"
                  }}>
                    Confirmed (Row {cj.row})
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* CRM OPPORTUNITIES */}
        {hasOpportunities && (
          <div style={{ marginBottom: "10px" }}>
            <div style={{ fontWeight: "600", color: "#1e293b", marginBottom: "6px" }}>Opportunity Updates:</div>
            <ul style={{ margin: "0", paddingLeft: "18px", lineHeight: "1.6" }}>
              {details.opportunities.map((op, i) => (
                <li key={i}>
                  {op.name ? <strong>{op.name}: </strong> : null}
                  <span>{op.details || op.note || JSON.stringify(op)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* CRM SKIPPED / VERIFIED EXISTING JOBS */}
        {hasSkippedJobs && (
          <div style={{ marginBottom: "10px" }}>
            <div style={{ fontWeight: "600", color: "#475569", marginBottom: "6px" }}>
              Verified / Skipped Existing Jobs ({details.skippedJobs.length}):
            </div>
            <ul style={{ margin: "0", paddingLeft: "18px", lineHeight: "1.5", fontSize: "11px", color: "#64748b" }}>
              {details.skippedJobs.map((sj, i) => (
                <li key={i}>
                  <code style={{ fontSize: "10.5px", color: "#0369a1" }}>{sj.projectCode}</code>: {sj.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* SESSION OVERVIEW & PAGE VIEWS */}
        {(hasViews || details.totalViews > 0 || details.durationMins > 0) && (
          <div style={{ marginBottom: "10px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px", flexWrap: "wrap", gap: "6px" }}>
              <div style={{ fontWeight: "600", color: "#1e293b" }}>
                Session Overview ({details.totalViews || 0} page{details.totalViews === 1 ? "" : "s"} viewed):
              </div>
              {details.timeSpanText && (
                <span style={{
                  fontSize: "11px",
                  fontWeight: "600",
                  color: "#0369a1",
                  background: "#e0f2fe",
                  padding: "2px 8px",
                  borderRadius: "12px"
                }}>
                  Duration: {details.timeSpanText}
                </span>
              )}
            </div>

            {/* Unique pages visited summary pills */}
            {details.pageFrequencies && Object.keys(details.pageFrequencies).length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "8px" }}>
                {Object.entries(details.pageFrequencies).map(([pg, count], i) => (
                  <span key={i} style={{
                    background: "#ffffff",
                    border: "1px solid #cbd5e1",
                    borderRadius: "4px",
                    padding: "3px 8px",
                    fontSize: "11px",
                    color: "#334155"
                  }}>
                    <strong style={{ textTransform: "capitalize", color: "#0284c7" }}>{pg}</strong>
                    <span style={{ color: "#64748b", marginLeft: "4px" }}>({count})</span>
                  </span>
                ))}
              </div>
            )}

            {/* Individual view stream */}
            {hasViews && (
              <details style={{ marginTop: "6px" }}>
                <summary style={{ color: "#64748b", fontSize: "11px", fontWeight: "600", cursor: "pointer" }}>
                  View Click Stream ({details.viewsLog.length} events)
                </summary>
                <div style={{
                  maxHeight: "150px",
                  overflowY: "auto",
                  marginTop: "6px",
                  padding: "6px 8px",
                  background: "#ffffff",
                  border: "1px solid #e2e8f0",
                  borderRadius: "4px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px"
                }}>
                  {details.viewsLog.map((v, i) => {
                    const timeStr = v.time
                      ? new Date(v.time).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                      : null;
                    return (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: "11px" }}>
                        <span style={{ textTransform: "capitalize", fontWeight: "500", color: "#1e293b" }}>
                          {v.page || "page view"}
                        </span>
                        {timeStr && <span style={{ color: "#94a3b8", fontFamily: "monospace" }}>{timeStr}</span>}
                      </div>
                    );
                  })}
                </div>
              </details>
            )}
          </div>
        )}

        {/* JOB CHANGES */}
        {hasChanges && (
          <div style={{ marginBottom: "10px" }}>
            <div style={{ fontWeight: "600", color: "#1e293b", marginBottom: "6px" }}>Modified Fields:</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              {Object.entries(details.changes).map(([field, val], i) => (
                <div key={i} style={{ fontFamily: "monospace", fontSize: "11px" }}>
                  <span style={{ fontWeight: "600", color: "#0f766e" }}>{field}:</span>{" "}
                  <span style={{ color: "#334155" }}>{JSON.stringify(val)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* RAW LOG ACCORDION */}
        {ev.rawDetails && (
          <details style={{ marginTop: "6px", cursor: "pointer" }}>
            <summary style={{ color: "#64748b", fontSize: "11px", fontWeight: "600" }}>Raw Log Detail</summary>
            <pre style={{
              margin: "6px 0 0 0",
              padding: "8px",
              background: "#1e293b",
              color: "#f1f5f9",
              borderRadius: "4px",
              fontSize: "10.5px",
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word"
            }}>
              {ev.rawDetails}
            </pre>
          </details>
        )}
      </div>
    );
  };

  // Render a single Event Row
  const renderEventItem = (ev, compact = false) => {
    const isExpanded = expandedEvents.has(ev.id);

    return (
      <div key={ev.id} style={{
        padding: compact ? "8px 10px" : "12px 14px",
        borderBottom: "1px solid #f1f5f9",
        transition: "background 0.15s ease",
        background: isExpanded ? "#f8fafc" : "transparent"
      }}>
        {/* Whole Summary Item is Clickable to Expand / Collapse */}
        <div
          onClick={() => toggleExpand(ev.id)}
          style={{
            cursor: "pointer",
            borderRadius: "4px",
            userSelect: "none"
          }}
          title={isExpanded ? "Click to collapse" : "Click to view details"}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              {renderBadge(ev)}
              <span style={{ fontSize: "11.5px", color: "#64748b", fontWeight: "500" }}>
                {ev.relativeTime}
              </span>
              {ev.userEmail && (
                <span style={{
                  fontSize: "10.5px",
                  color: "#475569",
                  background: "#f1f5f9",
                  padding: "1px 6px",
                  borderRadius: "3px",
                  fontFamily: "monospace"
                }}>
                  {ev.userEmail}
                </span>
              )}
            </div>

            <div
              style={{
                color: "#0284c7",
                fontSize: "11px",
                fontWeight: "600",
                padding: "2px 4px",
                display: "flex",
                alignItems: "center",
                gap: "2px",
                flexShrink: 0
              }}
            >
              {isExpanded ? "▲ Less" : "▼ Detail"}
            </div>
          </div>

          <div style={{
            marginTop: "6px",
            fontSize: compact ? "12px" : "13.5px",
            fontWeight: "500",
            color: "#1e293b",
            lineHeight: "1.4"
          }}>
            {ev.summary}
          </div>
        </div>

        {isExpanded && renderEventDetails(ev)}
      </div>
    );
  };

  // Sort clients: active clients first (alphabetical A-Z), zero-event clients LAST (alphabetical A-Z)
  const sortedClients = [...allOutgoingsClients].sort((a, b) => {
    const infoA = activityData.clients[a.clientName] || { events: [] };
    const infoB = activityData.clients[b.clientName] || { events: [] };
    const hasA = (infoA.events || []).length > 0;
    const hasB = (infoB.events || []).length > 0;

    // Clients with events come first, clients without events come LAST
    if (hasA && !hasB) return -1;
    if (!hasA && hasB) return 1;

    // Within both groups (active or inactive), sort alphabetically A-Z
    return a.clientName.localeCompare(b.clientName);
  });

  return (
    <div style={{ padding: "20px 24px", maxWidth: "1400px", margin: "0 auto" }}>
      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "16px",
        marginBottom: "20px",
        background: "#fff",
        padding: "16px 20px",
        borderRadius: "8px",
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
        border: "1px solid #e2e8f0"
      }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <h2 style={{ fontSize: "22px", fontWeight: "700", color: "#0f172a", margin: 0 }}>
              Activity Feed
            </h2>
            <span style={{
              background: "#e2e8f0",
              color: "#475569",
              padding: "2px 8px",
              borderRadius: "12px",
              fontSize: "11px",
              fontWeight: "600"
            }}>
              Last 30 Days
            </span>
          </div>
          <div style={{ fontSize: "12.5px", color: "#64748b", marginTop: "4px" }}>
            Real-time unified timeline of automated runs, invoice syncs, and client user actions.
            {lastRefreshStr && <span style={{ marginLeft: "6px" }}>• Last synced {lastRefreshStr}</span>}
            {isRefreshing && (
              <span style={{
                marginLeft: "8px",
                color: "#0284c7",
                fontWeight: "600",
                display: "inline-flex",
                alignItems: "center",
                gap: "5px"
              }}>
                <Spinner size={11} color="#0284c7" /> Checking Google Sheets for updates...
              </span>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          {/* CLIENT SELECTOR DROPDOWN */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <label style={{ fontSize: "12px", fontWeight: "600", color: "#475569" }}>Client:</label>
            <select
              value={selectedClient}
              onChange={handleClientChange}
              style={{
                padding: "7px 12px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                fontSize: "13px",
                fontWeight: "500",
                color: "#1e293b",
                background: "#f8fafc",
                cursor: "pointer",
                outline: "none"
              }}
            >
              <option value="ALL">All Clients ({allOutgoingsClients.length})</option>
              {allOutgoingsClients.map(c => (
                <option key={c.clientName} value={c.clientName}>{c.clientName}</option>
              ))}
            </select>
          </div>

          {/* ROUTINE TOGGLE */}
          <label style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            fontSize: "12px",
            color: "#475569",
            cursor: "pointer",
            userSelect: "none"
          }}>
            <input
              type="checkbox"
              checked={includeRoutine}
              onChange={handleRoutineToggle}
              style={{ cursor: "pointer" }}
            />
            <span>Include zero-change checks</span>
          </label>

          {/* REFRESH BUTTON */}
          <button
            onClick={() => loadActivity({ forceRefresh: true })}
            disabled={isLoading || isRefreshing}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              background: "#0284c7",
              color: "#fff",
              border: "none",
              padding: "7px 14px",
              borderRadius: "6px",
              fontSize: "13px",
              fontWeight: "600",
              cursor: isLoading || isRefreshing ? "not-allowed" : "pointer",
              boxShadow: "0 1px 2px rgba(0,0,0,0.05)"
            }}
          >
            {isRefreshing || isLoading ? <Spinner size={13} color="#fff" /> : "↻"}
            <span>{isRefreshing ? "Refreshing..." : "Refresh"}</span>
          </button>
        </div>
      </div>

      {/* ── ERROR BANNER ───────────────────────────────────────────────────── */}
      {error && (
        <div style={{
          background: "#fef2f2",
          border: "1px solid #fecaca",
          color: "#991b1b",
          padding: "12px 16px",
          borderRadius: "6px",
          marginBottom: "16px",
          fontSize: "13px"
        }}>
          ⚠️ {error}
        </div>
      )}

      {/* ── LOADING STATE ──────────────────────────────────────────────────── */}
      {isLoading && (!activityData.allEvents || activityData.allEvents.length === 0) ? (
        <div style={{ textAlign: "center", padding: "60px 20px" }}>
          <Spinner size={32} color="#0284c7" />
          <div style={{ marginTop: "14px", color: "#64748b", fontSize: "14px", fontWeight: "500" }}>
            Aggregating 30-day activity across clients...
          </div>
        </div>
      ) : selectedClient !== "ALL" ? (
        /* ── SINGLE CLIENT DEEP FEED ───────────────────────────────────────── */
        <div style={{
          background: "#fff",
          borderRadius: "8px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
          border: "1px solid #e2e8f0",
          overflow: "hidden"
        }}>
          <div style={{
            padding: "14px 20px",
            background: "#f8fafc",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center"
          }}>
            <div>
              <span style={{ fontSize: "12px", color: "#0284c7", fontWeight: "600", cursor: "pointer" }} onClick={() => setSelectedClient("ALL")}>
                ← Back to All Clients
              </span>
              <h3 style={{ margin: "4px 0 0 0", fontSize: "18px", color: "#0f172a" }}>
                {selectedClient} Timeline
              </h3>
            </div>
            <div style={{ fontSize: "12px", color: "#64748b" }}>
              {(activityData.clients[selectedClient]?.events || []).length} events found
            </div>
          </div>

          <div style={{ maxHeight: "75vh", overflowY: "auto" }}>
            {(!activityData.clients[selectedClient] || activityData.clients[selectedClient].events.length === 0) ? (
              <div style={{ padding: "40px", textAlign: "center", color: "#94a3b8" }}>
                No events found for {selectedClient} in the last 30 days.
              </div>
            ) : (
              activityData.clients[selectedClient].events.map(ev => renderEventItem(ev, false))
            )}
          </div>
        </div>
      ) : (
        /* ── ALL CLIENTS MULTI-CARD GRID (OPTION A) ────────────────────────── */
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))",
          gap: "20px"
        }}>
          {sortedClients.map((client) => {
            const clientInfo = activityData.clients[client.clientName] || { events: [], totalEvents: 0 };
            const clientEvents = clientInfo.events || [];
            const hasEvents = clientEvents.length > 0;
            // Show up to 15 events in the in-card scrollable container
            const displayEvents = clientEvents.slice(0, 15);

            return (
              <div
                key={client.clientName}
                style={{
                  background: "#fff",
                  borderRadius: "8px",
                  border: "1px solid #e2e8f0",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden"
                }}
              >
                {/* CARD HEADER */}
                <div style={{
                  padding: "12px 16px",
                  background: "#f8fafc",
                  borderBottom: "1px solid #e2e8f0",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center"
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{
                      width: "8px",
                      height: "8px",
                      borderRadius: "50%",
                      background: hasEvents ? "#10b981" : "#cbd5e1"
                    }} />
                    <strong style={{ fontSize: "15px", color: "#0f172a" }}>
                      {client.clientName}
                    </strong>
                  </div>
                  <button
                    onClick={() => {
                      setSelectedClient(client.clientName);
                      loadActivity({ clientName: client.clientName, includeRoutine });
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "#0284c7",
                      fontSize: "12px",
                      fontWeight: "600",
                      cursor: "pointer",
                      padding: "0"
                    }}
                  >
                    View full feed →
                  </button>
                </div>

                {/* IN-CARD SCROLLABLE CONTAINER WITH HOVER-INTENT ACTIVATION */}
                <CardScrollContainer hasEvents={hasEvents}>
                  {!hasEvents ? (
                    <div style={{ padding: "30px 16px", textAlign: "center", color: "#94a3b8", fontSize: "12px" }}>
                      No recent activity recorded
                    </div>
                  ) : (
                    displayEvents.map(ev => renderEventItem(ev, true))
                  )}
                </CardScrollContainer>

                {/* CARD FOOTER */}
                {hasEvents && (
                  <div style={{
                    padding: "8px 16px",
                    background: "#f8fafc",
                    borderTop: "1px solid #f1f5f9",
                    fontSize: "11px",
                    color: "#64748b",
                    display: "flex",
                    justifyContent: "space-between"
                  }}>
                    <span>Showing latest {displayEvents.length} of {clientEvents.length}</span>
                    {clientEvents.length > 15 && (
                      <span
                        style={{ color: "#0284c7", cursor: "pointer", fontWeight: "600" }}
                        onClick={() => {
                          setSelectedClient(client.clientName);
                          loadActivity({ clientName: client.clientName, includeRoutine });
                        }}
                      >
                        +{clientEvents.length - 15} more in timeline
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
