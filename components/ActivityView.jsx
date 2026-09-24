import React, { useEffect } from "react";
import Spinner from "./Spinner";
import { useActivity } from "../hooks/useActivity";

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

  // SWR: Trigger full background refresh on mount
  const revalidatedRef = React.useRef(false);
  useEffect(() => {
    if (!revalidatedRef.current) {
      revalidatedRef.current = true;
      loadActivity({ forceRefresh: true });
    }
  }, [loadActivity]);

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

  // Render Category Badge
  const renderBadge = (ev) => {
    const isAuto = ev.source === "auto";
    let bg = "#eef2ff";
    let color = "#3730a3";
    let icon = "🤖";

    if (isAuto) {
      if (ev.category === "INVOICES") {
        bg = "#e0f2fe";
        color = "#0369a1";
        icon = "🧾";
      } else if (ev.category === "CRM") {
        bg = "#f3e8ff";
        color = "#7e22ce";
        icon = "🎯";
      } else if (ev.category === "EXPENSES") {
        bg = "#fef3c7";
        color = "#b45309";
        icon = "💳";
      } else if (ev.category === "CLIENT_AUTH") {
        bg = "#dcfce7";
        color = "#15803d";
        icon = "🔗";
      }
    } else {
      icon = "👤";
      if (ev.category === "JOB") {
        bg = "#dcfce7";
        color = "#166534";
      } else if (ev.category === "SESSION") {
        bg = "#f0fdf4";
        color = "#047857";
      } else if (ev.category === "OUTGOINGS") {
        bg = "#ffedd5";
        color = "#c2410c";
      }
    }

    return (
      <span style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "2px 7px",
        borderRadius: "4px",
        fontSize: "11px",
        fontWeight: "600",
        background: bg,
        color: color,
        letterSpacing: "0.2px",
        textTransform: "uppercase"
      }}>
        <span>{icon}</span>
        <span>{isAuto ? "Auto" : "User"} • {ev.category}</span>
      </span>
    );
  };

  // Render Details Drawer
  const renderEventDetails = (ev) => {
    const details = ev.structuredDetails || {};
    const hasInvoices = Array.isArray(details.invoices) && details.invoices.length > 0;
    const hasInvoiceGaps = Array.isArray(details.invoiceGaps) && details.invoiceGaps.length > 0;
    const hasExpenses = Array.isArray(details.expenses) && details.expenses.length > 0;
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
          <div style={{ marginBottom: "12px" }}>
            <div style={{ fontWeight: "600", color: "#1e293b", marginBottom: "8px" }}>
              Created Invoice Gaps ({details.invoiceGaps.length}):
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {details.invoiceGaps.map((gap, i) => (
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

        {/* INVOICES TABLE */}
        {hasInvoices && (
          <div style={{ marginBottom: "12px" }}>
            <div style={{ fontWeight: "600", color: "#1e293b", marginBottom: "8px" }}>
              Invoices Adjusted / Imported ({details.invoices.length}):
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
                  {details.invoices.map((inv, i) => {
                    let badgeBg = "#f1f5f9";
                    let badgeColor = "#475569";
                    if (inv.statusType === "paid" || inv.status?.toLowerCase().includes("paid")) {
                      badgeBg = "#dcfce7";
                      badgeColor = "#166534";
                    } else if (inv.statusType === "overdue" || inv.status?.toLowerCase().includes("overdue") || inv.status?.toLowerCase().includes("sent (was")) {
                      badgeBg = "#fee2e2";
                      badgeColor = "#991b1b";
                    } else if (inv.statusType === "new" || inv.status?.toLowerCase().includes("new")) {
                      badgeBg = "#e0f2fe";
                      badgeColor = "#0369a1";
                    } else if (inv.statusType === "transition" || inv.status?.toLowerCase().includes("authorised")) {
                      badgeBg = "#f3e8ff";
                      badgeColor = "#6b21a8";
                    }

                    return (
                      <tr key={i} style={{ borderBottom: i < details.invoices.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                        <td style={{ padding: "8px 10px", fontWeight: "600", color: "#1e293b", fontFamily: "monospace", verticalAlign: "top" }}>
                          {inv.invoiceNumber || "—"}
                        </td>
                        <td style={{ padding: "8px 10px" }}>
                          {/* Client & Job Title */}
                          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px" }}>
                            <strong style={{ color: "#0f172a", fontSize: "12px" }}>
                              {inv.clientName || inv.description || "Invoice"}
                            </strong>
                            {inv.jobName && (
                              <span style={{ color: "#64748b", fontSize: "11.5px" }}>• {inv.jobName}</span>
                            )}
                          </div>

                          {/* Status, Amount, Dates, and Sheet Info Badges */}
                          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px", marginTop: "5px" }}>
                            {/* Status Badge */}
                            <span style={{
                              padding: "2px 7px",
                              borderRadius: "4px",
                              fontSize: "10.5px",
                              fontWeight: "600",
                              background: badgeBg,
                              color: badgeColor
                            }}>
                              {inv.status || "Updated"}
                            </span>

                            {/* Amount Badge */}
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

                            {/* Date Badges */}
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

                            {/* Location / Sheet Tag */}
                            {(inv.sheet || inv.slot) && (
                              <span style={{
                                padding: "1px 6px",
                                borderRadius: "3px",
                                background: "#fef3c7",
                                color: "#92400e",
                                fontSize: "10.5px",
                                fontWeight: "500"
                              }}>
                                {inv.sheet || "Confirmed"}{inv.slot ? ` • ${inv.slot}` : ""}{inv.row ? ` (Row ${inv.row})` : ""}
                              </span>
                            )}
                          </div>

                          {/* Raw Changes Details */}
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

        {/* EXPENSES TABLE */}
        {hasExpenses && (
          <div style={{ marginBottom: "12px" }}>
            <div style={{ fontWeight: "600", color: "#1e293b", marginBottom: "8px" }}>
              Expenses Adjusted / Matched ({details.expenses.length}):
            </div>
            <div style={{ overflowX: "auto", border: "1px solid #e2e8f0", borderRadius: "6px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px", background: "#fff" }}>
                <thead>
                  <tr style={{ background: "#f1f5f9", textAlign: "left", borderBottom: "1px solid #e2e8f0" }}>
                    <th style={{ padding: "6px 10px", fontWeight: "600", color: "#475569" }}>Expense / Supplier & Status Details</th>
                  </tr>
                </thead>
                <tbody>
                  {details.expenses.map((exp, i) => {
                    let badgeBg = "#f1f5f9";
                    let badgeColor = "#475569";
                    const st = (exp.status || "").toLowerCase();
                    if (st.includes("paid")) {
                      badgeBg = "#dcfce7";
                      badgeColor = "#166534";
                    } else if (st.includes("vat")) {
                      badgeBg = "#e0e7ff";
                      badgeColor = "#3730a3";
                    } else if (st.includes("manual") || st.includes("date moved") || st.includes("date")) {
                      badgeBg = "#fef3c7";
                      badgeColor = "#92400e";
                    } else if (st.includes("new")) {
                      badgeBg = "#e0f2fe";
                      badgeColor = "#0369a1";
                    } else if (st.includes("matched") || st.includes("created")) {
                      badgeBg = "#f0fdf4";
                      badgeColor = "#15803d";
                    }

                    return (
                      <tr key={i} style={{ borderBottom: i < details.expenses.length - 1 ? "1px solid #f1f5f9" : "none" }}>
                        <td style={{ padding: "8px 10px" }}>
                          {/* Supplier / Description & Context */}
                          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "4px" }}>
                            <strong style={{ color: "#0f172a", fontSize: "12px" }}>
                              {exp.supplier || exp.description || "Expense"}
                            </strong>
                            {exp.jobOrRef && (
                              <span style={{ color: "#64748b", fontSize: "11.5px" }}>• {exp.jobOrRef}</span>
                            )}
                          </div>

                          {/* Status, Amount, Dates, and Sheet Info Badges */}
                          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px", marginTop: "5px" }}>
                            {/* Status Badge */}
                            <span style={{
                              padding: "2px 7px",
                              borderRadius: "4px",
                              fontSize: "10.5px",
                              fontWeight: "600",
                              background: badgeBg,
                              color: badgeColor
                            }}>
                              {exp.status || "Updated"}
                            </span>

                            {/* Amount Badge */}
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

                            {/* Date Badges */}
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

                            {/* Sheet Info (NEVER UUIDs) */}
                            {exp.sheet && exp.sheet !== "Accounting" && (
                              <span style={{
                                padding: "1px 6px",
                                borderRadius: "3px",
                                background: "#fef3c7",
                                color: "#92400e",
                                fontSize: "10.5px",
                                fontWeight: "500"
                              }}>
                                {exp.sheet}{exp.slot ? ` • ${exp.slot}` : ""}{exp.row && !String(exp.row).includes("-") ? ` (Row ${exp.row})` : ""}
                              </span>
                            )}
                          </div>

                          {/* Raw Changes Details */}
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

          <button
            onClick={() => toggleExpand(ev.id)}
            style={{
              background: "none",
              border: "none",
              color: "#0284c7",
              fontSize: "11px",
              fontWeight: "600",
              cursor: "pointer",
              padding: "2px 4px",
              display: "flex",
              alignItems: "center",
              gap: "2px"
            }}
          >
            {isExpanded ? "▲ Less" : "▼ Detail"}
          </button>
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

        {isExpanded && renderEventDetails(ev)}
      </div>
    );
  };

  // Sort clients: active clients first (newest timestamp first), zero-event clients LAST
  const sortedClients = [...allOutgoingsClients].sort((a, b) => {
    const infoA = activityData.clients[a.clientName] || { events: [] };
    const infoB = activityData.clients[b.clientName] || { events: [] };
    const hasA = (infoA.events || []).length > 0;
    const hasB = (infoB.events || []).length > 0;

    // Clients with events come first, clients without events come LAST
    if (hasA && !hasB) return -1;
    if (!hasA && hasB) return 1;
    if (!hasA && !hasB) return a.clientName.localeCompare(b.clientName);

    // Both have events: sort by most recent activity timestamp (newest first)
    const timeA = infoA.events[0]?.timestampMs || 0;
    const timeB = infoB.events[0]?.timestampMs || 0;
    return timeB - timeA;
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

                {/* IN-CARD SCROLLABLE CONTAINER (SHOWS LATEST UP TO 15 ENTRIES) */}
                <div style={{
                  maxHeight: "360px",
                  overflowY: "auto",
                  flex: 1
                }}>
                  {!hasEvents ? (
                    <div style={{ padding: "30px 16px", textAlign: "center", color: "#94a3b8", fontSize: "12px" }}>
                      No recent activity recorded
                    </div>
                  ) : (
                    displayEvents.map(ev => renderEventItem(ev, true))
                  )}
                </div>

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
