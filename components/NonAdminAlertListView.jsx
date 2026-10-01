import React from "react";
import Spinner from "./Spinner";
import TruncatedCode from "./TruncatedCode";
import { stripRowInfo, parseUnreceivedExpensesDetail, parseStaleExpenseDetail, filterAnalysisResultsForAlert } from "../utils/helpers";

export default function NonAdminAlertListView({
  styles,
  groupedAlerts,
  groupedInfoAlerts,
  groupedProactiveAlerts,
  getGroupSectionHeader,
  getFlagName,
  PROACTIVE_TYPE_LABELS,
  renderAlertContent,
  selectAlert,
  selectedClient,
  setActiveNav,
  resolvedNoActionFlags,
  noActionAnalysis,
  noActionAnalysisLoading,
  analyzeNoActionFlag,
  handleMarkNoActionResolved,
  openCreateTaskModal,
  clientsWithFlags,
  allClientsMap,
  setRetainerAlertResolution,
  setRetainerSplitInvoice,
  acknowledgeProactiveAlert,
  freqLabel,
  totalVisibleAlertsCount
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* 1. Actionable Groups */}
      {Object.keys(groupedAlerts).map((type) => {
        const groupAlerts = groupedAlerts[type];
        return (
          <div key={`act-${type}`}>
            <h3 style={{ fontSize: "14px", fontWeight: "bold", color: "#1976d2", margin: "0 0 10px 0" }}>
              {getGroupSectionHeader(type, groupAlerts)}
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {(() => {
                const isInvoiceType = type === "invoiceDashboardDiscr";
                if (isInvoiceType) {
                  const drafts = groupAlerts
                    .filter(a => (a.summary?.status || "").toLowerCase() === "draft")
                    .sort((a, b) => parseInt(a.summary?.invoiceNo || 0) - parseInt(b.summary?.invoiceNo || 0));
                  const nonDrafts = groupAlerts
                    .filter(a => (a.summary?.status || "").toLowerCase() !== "draft")
                    .sort((a, b) => parseInt(a.summary?.invoiceNo || 0) - parseInt(b.summary?.invoiceNo || 0));
                  const renderSubList = (alerts, label) => alerts.length === 0 ? null : (
                    <div key={label}>
                      <div style={{ fontSize: "11px", fontWeight: "700", color: "#888", textTransform: "uppercase", letterSpacing: "0.05em", padding: "6px 0 4px" }}>
                        {label}
                      </div>
                      {alerts.map((alert, idx) => (
                        <button
                          className="triage-btn"
                          key={idx}
                          onClick={() => selectAlert(alert)}
                          style={{
                            ...styles.optionButton,
                            textAlign: "left",
                            padding: "12px",
                            border: "1px solid #e0e0e0",
                            borderRadius: "4px",
                            cursor: "pointer",
                            backgroundColor: "#fff",
                            fontSize: "13px",
                            transition: "all 0.2s",
                            marginBottom: "8px",
                            width: "100%"
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#f5f5f5"; e.currentTarget.style.borderColor = "#1976d2"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "#fff"; e.currentTarget.style.borderColor = "#e0e0e0"; }}
                        >
                          {renderAlertContent(alert)}
                        </button>
                      ))}
                    </div>
                  );
                  return (
                    <div>
                      {renderSubList(nonDrafts, "Sent / non-draft")}
                      {renderSubList(drafts, "Draft")}
                      {selectedClient && (
                        <div style={{ display: "flex", justifyContent: "flex-start", marginTop: "4px" }}>
                          <button
                            className="triage-btn"
                            onClick={() => setActiveNav("invoices")}
                            style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 14px", color: "#ea580c", borderColor: "#fdba74" }}
                          >
                            📥 Assign Invoices
                          </button>
                        </div>
                      )}
                    </div>
                  );
                }
                const isExpenseGroup = type === "expenseDashboardDiscr";
                const isInvoiceGroup = type === "invoiceDashboardDiscr";
                return (
                  <>
                    {groupAlerts.map((alert, idx) => (
                      <button
                        className="triage-btn"
                        key={idx}
                        onClick={() => selectAlert(alert)}
                        style={{
                          ...styles.optionButton,
                          textAlign: "left",
                          padding: "12px",
                          border: "1px solid #e0e0e0",
                          borderRadius: "4px",
                          cursor: "pointer",
                          backgroundColor: "#fff",
                          fontSize: "13px",
                          transition: "all 0.2s",
                          width: "100%"
                        }}
                        onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#f5f5f5"; e.currentTarget.style.borderColor = "#1976d2"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "#fff"; e.currentTarget.style.borderColor = "#e0e0e0"; }}
                      >
                        {renderAlertContent(alert)}
                      </button>
                    ))}
                    {isExpenseGroup && selectedClient && (
                      <div style={{ display: "flex", justifyContent: "flex-start", marginTop: "4px" }}>
                        <button
                          className="triage-btn"
                          onClick={() => setActiveNav("outgoings")}
                          style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 14px", color: "#059669", borderColor: "#6ee7b7" }}
                        >
                          📤 Assign Expense
                        </button>
                      </div>
                    )}
                    {isInvoiceGroup && selectedClient && (
                      <div style={{ display: "flex", justifyContent: "flex-start", marginTop: "4px" }}>
                        <button
                          className="triage-btn"
                          onClick={() => setActiveNav("invoices")}
                          style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 14px", color: "#ea580c", borderColor: "#fdba74" }}
                        >
                          📥 Assign Invoices
                        </button>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        );
      })}

      {/* 2. Informational Groups */}
      {Object.keys(groupedInfoAlerts).map(type => {
        const groupAlerts = groupedInfoAlerts[type];
        return (
          <div key={`info-${type}`}>
            <h3 style={{ fontSize: "14px", fontWeight: "bold", color: "#1976d2", margin: "0 0 10px 0" }}>
              {getFlagName(type)}
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {groupAlerts.map(na => {
                const alertId = na.fingerprintHash || `${na.flagType}-${na.flagDetail || ""}`;
                const isResolved = resolvedNoActionFlags.has(alertId);
                const isRichFlag = ["crmCopiedConfChecked", "crmCopiedConfUnchecked", "retainerInvoicesCreated", "retainerInvoicesDeleted", "crmCopiedConfDelete", "invoiceStaleUnsentChanges"].includes(na.flagType);
                const rawAnalysis = noActionAnalysis[alertId] || na.analysisResult;
                const isLoading = noActionAnalysisLoading[alertId];
                const displayedResults = filterAnalysisResultsForAlert(rawAnalysis?.results, na.flagDetail);
                const overallOk = displayedResults.length > 0
                  ? displayedResults.every(r => r.status === "ok" || r.status === "info")
                  : (rawAnalysis?.overallOk ?? true);
                const analysis = rawAnalysis ? { ...rawAnalysis, results: displayedResults, overallOk } : null;

                if (isRichFlag && !isResolved) {
                  const overallOk = analysis?.overallOk;
                  return (
                    <div key={alertId} style={{ border: "1px solid #e0e0e0", borderRadius: "4px", background: "#fff", padding: "12px" }}>
                      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: analysis ? "10px" : "0", flexWrap: "wrap", gap: "8px" }}>
                        <div style={{ flexShrink: 1, minWidth: 0 }}>
                          <div style={{ fontSize: "13px", fontWeight: "600", color: "#333" }}>
                            {getFlagName(na.flagType) || na.flagName}
                          </div>
                          {na.flagDetail && (
                            <div style={{ fontSize: "12px", color: "#666", marginTop: "4px", lineHeight: "1.4" }}>
                              {stripRowInfo(na.flagDetail)}
                            </div>
                          )}
                          {(na.firstSeen || na.lastSeen) && (
                            <div style={{ fontSize: "10px", color: "#aaa", marginTop: "6px" }}>
                              {na.firstSeen ? `First seen: ${na.firstSeen.split("T")[0]}` : ""}
                              {na.firstSeen && na.lastSeen ? " · " : ""}
                              {na.lastSeen ? `Last seen: ${na.lastSeen.split("T")[0]}` : ""}
                            </div>
                          )}
                        </div>
                        <div style={{ display: "flex", gap: "6px", flexShrink: 0, flexWrap: "wrap" }}>
                          {selectedClient?.clientSheetId && (
                            <button
                              className="triage-btn"
                              onClick={() => {
                                if (selectedClient.clientSheetId) window.open(`https://docs.google.com/spreadsheets/d/${selectedClient.clientSheetId}/edit`, "_blank");
                                if (selectedClient.masterSheetId) window.open(`https://docs.google.com/spreadsheets/d/${selectedClient.masterSheetId}/edit`, "_blank");
                              }}
                              style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px", color: "#1d4ed8", borderColor: "#93c5fd" }}
                            >
                              📊 Open Sheets
                            </button>
                          )}
                          {!analysis && !isLoading && (
                            <button className="triage-btn" onClick={() => analyzeNoActionFlag(na)} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px" }}>
                              🔍 Analyse
                            </button>
                          )}
                          {isLoading && (
                            <span style={{ fontSize: "12px", color: "#888", padding: "5px 10px", display: "inline-flex", alignItems: "center" }}><Spinner size={12} />Analysing…</span>
                          )}
                          {analysis && !isLoading && (
                            <button className="triage-btn" onClick={() => analyzeNoActionFlag(na)} style={{ ...styles.buttonSecondary, fontSize: "11px", padding: "4px 8px" }}>
                              ↻ Re-run
                            </button>
                          )}
                          <button className="triage-btn" onClick={() => openCreateTaskModal(na, false, true)} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px", color: "#7c3aed", borderColor: "#c4b5fd" }}>
                            📋 Create Task
                          </button>
                          <button className="triage-btn" onClick={() => handleMarkNoActionResolved(na)} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px" }}>
                            ✓ Mark resolved
                          </button>
                        </div>
                      </div>
                      {analysis && !isLoading && (
                        <div>
                          <div style={{
                            padding: "6px 10px", borderRadius: "4px", marginBottom: "8px", fontSize: "12px", fontWeight: "600",
                            background: "#f0f9ff", color: "#0369a1", border: "1px solid #bae6fd"
                          }}>
                            {overallOk ? "✓ Everything looks correct" : "⚠ Issues found - review below"}
                          </div>
                          {(analysis.results || []).map((r, ri) => (
                            <div key={ri} style={{
                              marginBottom: "8px", padding: "8px 10px", borderRadius: "4px",
                              border: "1px solid #e0e0e0", background: "#f9fafb",
                            }}>
                              {(r.jobName || r.projectCode || r.contractor) && (
                                <div style={{ fontSize: "12px", fontWeight: "600", color: "#333", marginBottom: "4px" }}>
                                  {r.clientName && <span style={{ fontWeight: "400", color: "#666" }}>{r.clientName} - </span>}
                                  {r.contractor && !r.jobName && <span style={{ fontWeight: "600", color: "#333" }}>{r.contractor}</span>}
                                  {r.jobName || r.projectCode}
                                  {r.projectCode && r.jobName && <TruncatedCode code={r.projectCode} />}
                                  {r.periodLabel && <span style={{ fontWeight: "400", color: "#666", marginLeft: "6px" }}> - {r.periodLabel}</span>}
                                </div>
                              )}
                              {r.message && (!r.checks || r.checks.length === 0) && (
                                <div style={{ fontSize: "12px", color: "#666" }}>{stripRowInfo(r.message)}</div>
                              )}
                              {(r.checks || []).map((chk, ci) => (
                                <div key={ci} style={{ fontSize: "12px", color: chk.ok ? "#2e7d32" : "#c62828", marginTop: "2px" }}>
                                  {stripRowInfo(chk.message || "")}
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                }

                if (na.flagType === "expenseUnreconGaps") {
                  const parsed = parseStaleExpenseDetail(na.flagDetail);
                  return (
                    <div key={alertId} style={{
                      padding: "12px 14px", borderRadius: "6px",
                      border: `1px solid ${isResolved ? "#c8e6c9" : "#bae6fd"}`,
                      background: isResolved ? "#f1f8f2" : "#f0f9ff",
                      display: "flex", flexDirection: "column", gap: "10px",
                    }}>
                      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: "13px", fontWeight: "700", color: isResolved ? "#2e7d32" : "#0369a1", textDecoration: isResolved ? "line-through" : "none" }}>
                            {getFlagName(na.flagType) || na.flagName}
                          </div>
                          {parsed?.tab && (
                            <span style={{
                              fontSize: "11px", fontWeight: "700", textTransform: "uppercase", letterSpacing: "0.02em",
                              padding: "2px 7px", borderRadius: "4px", background: "#e0f2fe", color: "#0369a1", border: "1px solid #bae6fd",
                            }}>
                              {parsed.tab} tab
                            </span>
                          )}
                          {parsed?.month && (
                            <span style={{
                              fontSize: "11px", fontWeight: "600",
                              padding: "2px 7px", borderRadius: "4px", background: "#ffffff", color: "#334155", border: "1px solid #cbd5e1",
                            }}>
                              {parsed.month}
                            </span>
                          )}
                          {parsed?.slot && (
                            <span style={{
                              fontSize: "11px", fontWeight: "600",
                              padding: "2px 7px", borderRadius: "4px", background: "#ffffff", color: "#334155", border: "1px solid #cbd5e1",
                            }}>
                              Slot {parsed.slot}
                            </span>
                          )}
                        </div>

                        {isResolved ? (
                          <span style={{ fontSize: "12px", color: "#2e7d32", fontWeight: "600", whiteSpace: "nowrap" }}>✓ Resolved</span>
                        ) : (
                          <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                            <button
                              className="triage-btn"
                              onClick={() => openCreateTaskModal(na, false, true)}
                              style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px", color: "#7c3aed", borderColor: "#c4b5fd", whiteSpace: "nowrap" }}
                            >
                              📋 Create Task
                            </button>
                            <button
                              className="triage-btn"
                              onClick={() => handleMarkNoActionResolved(na)}
                              style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px", whiteSpace: "nowrap" }}
                            >
                              Mark resolved
                            </button>
                          </div>
                        )}
                      </div>

                      {parsed ? (
                        <div style={{
                          fontSize: "12px", color: "#475569",
                          backgroundColor: isResolved ? "#f8fdf9" : "#ffffff",
                          border: `1px solid ${isResolved ? "#dcfce7" : "#e0f2fe"}`,
                          borderRadius: "6px", padding: "10px 12px",
                          display: "flex", flexDirection: "column", gap: "6px",
                        }}>
                          {parsed.tab === "Outgoings" ? (
                            <>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
                                <div style={{ fontSize: "13px", fontWeight: "700", color: isResolved ? "#2e7d32" : "#0f172a" }}>
                                  Vendor: <span style={{ color: isResolved ? "#2e7d32" : "#1e293b" }}>{parsed.contractor}</span>
                                </div>
                                <span style={{ fontSize: "11px", color: "#64748b", fontWeight: "500" }}>Updated stale placeholder date</span>
                              </div>
                              {parsed.changes && parsed.changes.length > 0 && (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "4px" }}>
                                  {parsed.changes.map((ch, ci) => (
                                    <div key={ci} style={{
                                      padding: "4px 8px", borderRadius: "4px", fontSize: "12px", fontWeight: "600",
                                      background: isResolved ? "#f1f8f2" : "#f0f9ff",
                                      color: isResolved ? "#2e7d32" : "#0369a1",
                                      border: `1px solid ${isResolved ? "#bbf7d0" : "#bae6fd"}`,
                                    }}>
                                      {ch.label}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </>
                          ) : (
                            <>
                              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
                                <div style={{ fontSize: "13px", fontWeight: "700", color: isResolved ? "#2e7d32" : "#0f172a" }}>
                                  {parsed.client} <span style={{ fontWeight: "400", color: "#64748b" }}>|</span> {parsed.job}
                                </div>
                                {parsed.amount && (
                                  <div style={{ fontSize: "13px", fontWeight: "700", color: isResolved ? "#2e7d32" : "#0369a1" }}>
                                    Amount: {parsed.amount}
                                  </div>
                                )}
                              </div>
                              {parsed.changes && parsed.changes.length > 0 && (
                                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "4px" }}>
                                  {parsed.changes.map((ch, ci) => (
                                    <div key={ci} style={{
                                      padding: "4px 8px", borderRadius: "4px", fontSize: "12px", fontWeight: "600",
                                      background: isResolved ? "#f1f8f2" : "#f0f9ff",
                                      color: isResolved ? "#2e7d32" : "#0369a1",
                                      border: `1px solid ${isResolved ? "#bbf7d0" : "#bae6fd"}`,
                                    }}>
                                      {ch.label}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      ) : (
                        <div style={{ fontSize: "12px", color: isResolved ? "#2e7d32" : "#64748b", marginTop: "2px" }}>
                          {stripRowInfo(na.flagDetail)}
                        </div>
                      )}

                      {(na.firstSeen || na.lastSeen) && (
                        <div style={{ fontSize: "10px", color: "#94a3b8" }}>
                          {na.firstSeen ? `First seen: ${na.firstSeen.split("T")[0]}` : ""}
                          {na.firstSeen && na.lastSeen ? " · " : ""}
                          {na.lastSeen ? `Last seen: ${na.lastSeen.split("T")[0]}` : ""}
                        </div>
                      )}
                    </div>
                  );
                }

                return (
                  <div key={alertId} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderRadius: "4px",
                    border: `1px solid ${isResolved ? "#c8e6c9" : "#e0e0e0"}`, background: isResolved ? "#f1f8f2" : "#fff", gap: "12px",
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "13px", fontWeight: "600", color: isResolved ? "#2e7d32" : "#333", textDecoration: isResolved ? "line-through" : "none" }}>
                        {getFlagName(na.flagType) || na.flagName}
                      </div>
                      {na.flagDetail && (
                        <div style={{ fontSize: "12px", color: isResolved ? "#2e7d32" : "#666", marginTop: "4px", textDecoration: isResolved ? "line-through" : "none", lineHeight: "1.4" }}>
                          {stripRowInfo(na.flagDetail)}
                        </div>
                      )}
                      {(na.firstSeen || na.lastSeen) && (
                        <div style={{ fontSize: "10px", color: "#aaa", marginTop: "6px" }}>
                          {na.firstSeen ? `First seen: ${na.firstSeen.split("T")[0]}` : ""}
                          {na.firstSeen && na.lastSeen ? " · " : ""}
                          {na.lastSeen ? `Last seen: ${na.lastSeen.split("T")[0]}` : ""}
                        </div>
                      )}
                    </div>
                    {isResolved ? (
                      <span style={{ fontSize: "12px", color: "#2e7d32", fontWeight: "600", whiteSpace: "nowrap" }}>✓ Resolved</span>
                    ) : (
                      <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
                        <button
                          className="triage-btn"
                          onClick={() => openCreateTaskModal(na, false, true)}
                          style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px", color: "#7c3aed", borderColor: "#c4b5fd", whiteSpace: "nowrap" }}
                        >
                          📋 Create Task
                        </button>
                        <button
                          className="triage-btn"
                          onClick={() => handleMarkNoActionResolved(na)}
                          style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px", whiteSpace: "nowrap" }}
                        >
                          Mark resolved
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* 3. Proactive Groups */}
      {Object.keys(groupedProactiveAlerts).map(type => {
        const groupAlerts = groupedProactiveAlerts[type];
        return (
          <div key={`proactive-${type}`}>
            <h3 style={{ fontSize: "14px", fontWeight: "bold", color: "#1976d2", margin: "0 0 10px 0" }}>
              {PROACTIVE_TYPE_LABELS[type] || type || "Proactive Alert"}
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {groupAlerts.map((alert, idx) => {
                const m = alert.metadata || {};
                return (
                  <div key={idx} style={{ border: "1px solid #e0e0e0", borderRadius: "4px", padding: "14px", backgroundColor: "#fff" }}>
                    <div style={{ fontWeight: "600", fontSize: "14px", color: "#1a1a1a", marginBottom: "6px" }}>
                      {alert.heading}
                    </div>
                    <div style={{ fontSize: "13px", color: "#444", lineHeight: "1.6", marginBottom: "8px" }}>
                      {alert.alertType === "revenue_mismatch" || alert.alertType === "direct_costs_mismatch" || alert.alertType === "pipeline_confirmed_overlap" || alert.alertType === "retainer_shrink_blocked" || alert.alertType === "uninvoiced_new_job" || alert.alertType === "uninvoiced_revenue" || alert.alertType === "unreceived_expenses" ? null : stripRowInfo(alert.detail)}
                    </div>

                    {alert.alertType === "retainer_invoice" && (
                      <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                        {m.endClientName && <div><strong>End client:</strong> {m.endClientName}</div>}
                        {m.jobName && <div><strong>Job:</strong> {m.jobName}</div>}
                        {m.revenue && <div><strong>Monthly revenue:</strong> {m.revenue}</div>}
                        {m.startDate && <div><strong>Contract period:</strong> {m.startDate} → {m.endDate}</div>}
                        {m.frequencyDays && <div><strong>Invoice frequency:</strong> {freqLabel(m.frequencyDays)} (every ~{m.frequencyDays} days)</div>}
                        {m.lastInvoiceDate && <div><strong>Last invoice sent:</strong> {m.lastInvoiceDate}</div>}
                        {m.expectedByDate && <div><strong>Next expected by:</strong> {m.expectedByDate}</div>}
                        {m.possibleMatchInvoiceNo && (
                          <div style={{ marginTop: "8px", paddingTop: "8px", borderTop: "1px solid #bae6fd" }}>
                            {m.possibleMatchCase === "changed" && (
                              <div style={{ display: "inline-block", padding: "1px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "700", marginBottom: "6px", background: "#f0f9ff", color: "#0369a1", border: "1px solid #bae6fd" }}>
                                Possible retainer change - {m.possibleMatchConfidence === "high" ? "high" : "medium"} confidence
                              </div>
                            )}
                            {m.possibleMatchCase === "draft" && (
                              <div style={{ display: "inline-block", padding: "1px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "700", marginBottom: "6px", background: "#f0f9ff", color: "#0369a1", border: "1px solid #bae6fd" }}>
                                Draft invoice found nearby
                              </div>
                            )}
                            <div><strong>{m.possibleMatchCase === "draft" ? "DRAFT invoice found:" : "Invoice found:"}</strong> #{m.possibleMatchInvoiceNo} for £{parseFloat(m.possibleMatchAmount || 0).toFixed(2)}, sent {m.possibleMatchSentDate}</div>
                            <div>{m.possibleMatchConfirmedRow ? <>Already attached to Confirmed tab</> : <>Not yet attached to any job in the Confirmed tab</>}</div>
                            {m.possibleMatchCase === "changed" && <div style={{ marginTop: "4px" }}>This may mean the retainer value has changed.</div>}
                            {m.possibleMatchCase === "matches" && <div style={{ marginTop: "4px" }}>Matches the expected retainer amount.</div>}
                            {m.possibleMatchCase === "draft" && <div style={{ marginTop: "4px" }}>It likely just needs sending.</div>}
                          </div>
                        )}
                        {m.jobName && (!m.possibleMatchInvoiceNo || m.possibleMatchCase === "changed") && (
                          <div style={{ marginTop: "10px", paddingTop: "10px", borderTop: "1px solid #bae6fd", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                            {m.possibleMatchInvoiceNo ? (
                              <>
                                <button className="triage-btn" onClick={() => {
                                  const clientInfo = (clientsWithFlags || []).find(c => c.clientName === alert.clientName) || allClientsMap[alert.clientName];
                                  setRetainerAlertResolution({ resolutionType: "changeAmount", alertMeta: m, alertKey: alert.alertKey, clientSheetId: clientInfo?.clientSheetId, masterSheetId: clientInfo?.masterSheetId });
                                }} style={{ padding: "6px 12px", background: "#1976d2", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>Change retainer amount</button>
                                <button className="triage-btn" onClick={() => {
                                  const clientInfo = (clientsWithFlags || []).find(c => c.clientName === alert.clientName) || allClientsMap[alert.clientName];
                                  setRetainerSplitInvoice({ alertMeta: m, alertKey: alert.alertKey, clientSheetId: clientInfo?.clientSheetId, masterSheetId: clientInfo?.masterSheetId });
                                }} style={{ padding: "6px 12px", background: "#0284c7", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>Split invoice</button>
                              </>
                            ) : (
                              <button className="triage-btn" onClick={() => {
                                const clientInfo = (clientsWithFlags || []).find(c => c.clientName === alert.clientName) || allClientsMap[alert.clientName];
                                setRetainerAlertResolution({ resolutionType: "end", alertMeta: m, alertKey: alert.alertKey, clientSheetId: clientInfo?.clientSheetId, masterSheetId: clientInfo?.masterSheetId });
                              }} style={{ padding: "6px 12px", background: "#dc2626", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>End retainer</button>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {alert.alertType === "uninvoiced_new_job" && (
                      <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                        {m.endClientName && <div><strong>End client:</strong> {m.endClientName}</div>}
                        {m.jobName && <div><strong>Job:</strong> {m.jobName}{m.projectCode ? ` [${m.projectCode}]` : ""}</div>}
                        {m.startDate && <div><strong>Job started:</strong> {m.startDate}</div>}
                        {m.revenue && <div><strong>Revenue:</strong> £{parseFloat(m.revenue).toFixed(2)}</div>}
                        <div style={{ marginTop: "6px", fontWeight: "700", color: "#0369a1" }}>Over a month elapsed with zero real invoices sent.</div>
                      </div>
                    )}

                    {alert.alertType === "uninvoiced_revenue" && (
                      <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                        {m.endClientName && <div><strong>End client:</strong> {m.endClientName}</div>}
                        {m.jobName && <div><strong>Job:</strong> {m.jobName}{m.projectCode ? ` [${m.projectCode}]` : ""}</div>}
                        {m.endDate && <div><strong>Job ended:</strong> {m.endDate}</div>}
                        {m.revenue && <div><strong>Revenue:</strong> £{parseFloat(m.revenue).toFixed(2)}</div>}
                        {m.uninvoicedAmount && <div style={{ marginTop: "6px", fontWeight: "700", color: "#0369a1" }}>£{parseFloat(m.uninvoicedAmount).toFixed(2)} uninvoiced (placeholders and drafts excluded)</div>}
                        {m.draftCount && parseInt(m.draftCount) > 0 && <div style={{ marginTop: "6px", padding: "6px 8px", background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: "4px", color: "#0369a1" }}>{m.draftCount} invoice{parseInt(m.draftCount) > 1 ? "s" : ""} totalling £{parseFloat(m.draftTotal || 0).toFixed(2)} {parseInt(m.draftCount) > 1 ? "have" : "has"} a reference but {parseInt(m.draftCount) > 1 ? "are" : "is"} still <strong>Draft</strong> (not yet sent) - not counted as invoiced above.</div>}
                      </div>
                    )}

                    {alert.alertType === "unreceived_expenses" && (() => {
                      const parsed = (!m.directCosts && !alert.directCosts) ? parseUnreceivedExpensesDetail(alert.detail) : {};
                      const clientName = m.endClientName || m.jobClient || alert.endClientName || alert.jobClient || parsed.endClientName;
                      const jName = m.jobName || alert.jobName || parsed.jobName;
                      const pCode = m.projectCode || alert.projectCode || parsed.projectCode;
                      const eDate = m.endDate || alert.endDate || parsed.endDate;
                      const dCosts = m.directCosts || alert.directCosts || parsed.directCosts;
                      const unrecAmt = m.unreceivedAmount || alert.unreceivedAmount || parsed.unreceivedAmount;
                      const pCount = parseInt(m.placeholderCount || alert.placeholderCount || parsed.placeholderCount || "0", 10);
                      const pTotal = parseFloat(m.placeholderTotal || alert.placeholderTotal || parsed.placeholderTotal || "0");

                      return (
                        <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                          {clientName && <div><strong>End client:</strong> {clientName}</div>}
                          {jName && <div><strong>Job:</strong> {jName}{pCode ? ` [${pCode}]` : ""}</div>}
                          {eDate && <div><strong>Job ended:</strong> {eDate}</div>}
                          {dCosts && <div><strong>Direct cost budget:</strong> £{parseFloat(dCosts).toFixed(2)}</div>}
                          {unrecAmt && <div style={{ marginTop: "6px", fontWeight: "700", color: "#0369a1" }}>£{parseFloat(unrecAmt).toFixed(2)} unreceived (placeholders and estimates excluded)</div>}
                          {pCount > 0 && (
                            <div style={{ marginTop: "6px", padding: "6px 8px", background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: "4px", color: "#0369a1" }}>
                              {pCount} expense{pCount > 1 ? "s" : ""} totalling £{pTotal.toFixed(2)} {pCount > 1 ? "are placeholders - not counted as received above." : "is a placeholder - not counted as received above."}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {alert.alertType === "revenue_mismatch" && (
                      <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                        {(() => {
                          const detail = stripRowInfo(alert.detail || "");
                          const mismatchIdx = detail.indexOf("Mismatched entries:");
                          if (mismatchIdx === -1) return <div style={{ fontWeight: "600" }}>{detail}</div>;
                          const header = detail.slice(0, mismatchIdx).trim();
                          const rowsPart = detail.slice(mismatchIdx + "Mismatched entries:".length).trim();
                          const rows = rowsPart.split(";").map(s => s.trim()).filter(Boolean);
                          return (
                            <>
                              <div style={{ fontWeight: "600", marginBottom: "6px" }}>{header}</div>
                              <div style={{ fontWeight: "600", marginBottom: "4px" }}>Mismatched entries:</div>
                              {rows.map((row, i) => {
                                const diffMatch = row.match(/[-\u2014]\s*diff/);
                                const diffIdx = diffMatch ? diffMatch.index : -1;
                                if (diffIdx === -1) return <div key={i} style={{ paddingLeft: "8px", marginBottom: "2px" }}>• {row}</div>;
                                return <div key={i} style={{ paddingLeft: "8px", marginBottom: "2px" }}>• {row.slice(0, diffIdx)}<strong>{row.slice(diffIdx)}</strong></div>;
                              })}
                            </>
                          );
                        })()}
                      </div>
                    )}

                    {alert.alertType === "direct_costs_mismatch" && (
                      <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                        {alert.metadata?.tab && <span style={{ display: "inline-block", marginBottom: "6px", padding: "2px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "700", background: "#f0f9ff", color: "#0369a1", border: "1px solid #bae6fd" }}>{alert.metadata.tab} tab</span>}
                        {(() => {
                          const detail = stripRowInfo(alert.detail || "");
                          const mismatchIdx = detail.indexOf("Mismatched entries:");
                          if (mismatchIdx === -1) return <div style={{ fontWeight: "600" }}>{detail}</div>;
                          const header = detail.slice(0, mismatchIdx).trim();
                          const rowsPart = detail.slice(mismatchIdx + "Mismatched entries:".length).trim();
                          const rows = rowsPart.split(";").map(s => s.trim()).filter(Boolean);
                          return (
                            <>
                              <div style={{ fontWeight: "600", marginBottom: "6px" }}>{header}</div>
                              <div style={{ fontWeight: "600", marginBottom: "4px" }}>Mismatched entries:</div>
                              {rows.map((row, i) => {
                                const diffMatch = row.match(/[-\u2014]\s*diff/);
                                const diffIdx = diffMatch ? diffMatch.index : -1;
                                if (diffIdx === -1) return <div key={i} style={{ paddingLeft: "8px", marginBottom: "2px" }}>• {row}</div>;
                                return <div key={i} style={{ paddingLeft: "8px", marginBottom: "2px" }}>• {row.slice(0, diffIdx)}<strong>{row.slice(diffIdx)}</strong></div>;
                              })}
                            </>
                          );
                        })()}
                      </div>
                    )}

                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontSize: "11px", color: "#aaa" }}>First seen: {alert.firstSeen} · Last seen: {alert.lastSeen}</div>
                      <div style={{ display: "flex", gap: "8px" }}>
                        {(() => {
                          const clientInfo = (clientsWithFlags || []).find(c => c.clientName === selectedClient.clientName) || allClientsMap[selectedClient.clientName] || selectedClient;
                          return (
                            <>
                              {(clientInfo?.clientSheetId || clientInfo?.masterSheetId) && (
                                <button
                                  className="triage-btn"
                                  onClick={() => {
                                    if (clientInfo.clientSheetId) window.open(`https://docs.google.com/spreadsheets/d/${clientInfo.clientSheetId}/edit`, "_blank");
                                    if (clientInfo.masterSheetId) window.open(`https://docs.google.com/spreadsheets/d/${clientInfo.masterSheetId}/edit`, "_blank");
                                  }}
                                  style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#1d4ed8", borderColor: "#93c5fd" }}
                                >
                                  📊 Open Sheets
                                </button>
                              )}
                              {alert.alertType === "expenseDashboardDiscr" && clientInfo && (
                                <button className="triage-btn" onClick={() => setActiveNav("outgoings")} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#059669", borderColor: "#6ee7b7" }}>📤 Assign Expense</button>
                              )}
                              {alert.alertType === "invoiceDashboardDiscr" && clientInfo && (
                                <button className="triage-btn" onClick={() => setActiveNav("invoices")} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#ea580c", borderColor: "#fdba74" }}>📥 Assign Invoices</button>
                              )}
                            </>
                          );
                        })()}
                        <button className="triage-btn" onClick={() => openCreateTaskModal(alert, true)} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#7c3aed", borderColor: "#c4b5fd" }}>📋 Create Task</button>
                        <button className="triage-btn" onClick={() => acknowledgeProactiveAlert(alert.alertKey, alert.rowIndex)} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px" }}>✓ Acknowledge</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {totalVisibleAlertsCount === 0 && (
        <div style={{ textAlign: "center", padding: "40px 20px", color: "#666" }}>
          No alerts for this client
        </div>
      )}
    </div>
  );
}
