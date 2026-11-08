import React from "react";
import Spinner from "./Spinner";
import TruncatedCode from "./TruncatedCode";
import { stripRowInfo, sanitizeSpreadsheetTerms, parseRetroactiveOutgoingsDetail, parseUnreceivedExpensesDetail, parseStaleExpenseDetail, parseInfoAlertDetail, getInfoCardTitle, getProactiveCardTitle, filterAnalysisResultsForAlert, getCleanPLCategoryName, getAlertJobTarget, formatSeenTimestamp, parseRevenueMismatchDetail, parseDirectCostsMismatchDetail, toInputDateFormat, parseSheetDate, toSheetDateFormat, isNoEndDateSentinel, formatJobEndDateDisplay } from "../utils/helpers";

const KNOWN_PROACTIVE_TYPES = new Set([
  "retainer_invoice",
  "uninvoiced_new_job",
  "uninvoiced_revenue",
  "unreceived_expenses",
  "stale_unrecon_gap",
  "retroactive_outgoings_update",
  "unmapped_pl_category",
  "crm_wipe",
  "revenue_mismatch",
  "direct_costs_mismatch",
  "pipeline_confirmed_overlap",
  "retainer_shrink_blocked",
  "autolog_error",
  "infinite_loop",
  "deleted_invoice",
  "deleted_expense",
  "job_structure_error",
  "part_paid_balance",
]);

export default function NonAdminAlertListView({
  styles,
  sessionId,
  automationCommanderSheetId,
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
  onNavInvoices,
  onNavOutgoings,
  onNavPassThrough,
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
  setRetainerChangeSendDates,
  acknowledgeProactiveAlert,
  acknowledgingKey,
  exitingAlertKeys = new Set(),
  freqLabel,
  totalVisibleAlertsCount,
  onViewJob,
  onDeleteInvoice
}) {
  const [selectedClassifications, setSelectedClassifications] = React.useState({});
  const [applyingClassification, setApplyingClassification] = React.useState({});
  const [classificationMsg, setClassificationMsg] = React.useState({});
  const [expandedAutoLogAlerts, setExpandedAutoLogAlerts] = React.useState({});
  const [autoLogModalAlert, setAutoLogModalAlert] = React.useState(null);
  const [copiedAutoLog, setCopiedAutoLog] = React.useState(false);
  const [partPaidDates, setPartPaidDates] = React.useState({});
  const [updatingPartPaid, setUpdatingPartPaid] = React.useState({});
  const [partPaidMsg, setPartPaidMsg] = React.useState({});

  const getClientInfoForAlert = (alertObj) => {
    const cName = alertObj?.clientName || selectedClient?.clientName;
    const fromFlags = (clientsWithFlags || []).find(c => c.clientName === cName);
    if (fromFlags?.clientSheetId || fromFlags?.masterSheetId) return fromFlags;

    if (allClientsMap && cName) {
      if (allClientsMap[cName]?.clientSheetId || allClientsMap[cName]?.masterSheetId) {
        return allClientsMap[cName];
      }
      const match = Object.values(allClientsMap).find(cl => cl.clientName && cl.clientName.toLowerCase() === cName.toLowerCase());
      if (match?.clientSheetId || match?.masterSheetId) return match;
    }

    if (selectedClient && (!cName || selectedClient.clientName?.toLowerCase() === cName.toLowerCase())) {
      if (selectedClient.clientSheetId || selectedClient.masterSheetId) return selectedClient;
    }

    if (alertObj?.metadata?.clientSheetId || alertObj?.metadata?.masterSheetId) {
      return {
        clientName: cName,
        clientSheetId: alertObj.metadata.clientSheetId,
        masterSheetId: alertObj.metadata.masterSheetId,
      };
    }

    return selectedClient || null;
  };

  const handleApplyPLClassification = async (alert) => {
    const alertKey = alert.alertKey;
    const classification = selectedClassifications[alertKey] || alert.metadata?.suggestedClassification || alert.suggestedClassification || "delivery_expense";
    const categoryName = getCleanPLCategoryName(alert);
    const clientName = alert.clientName || selectedClient?.clientName;
    const targetMasterSheetId = alert.metadata?.masterSheetId || selectedClient?.masterSheetId;
    const targetClientSheetId = alert.metadata?.clientSheetId || selectedClient?.clientSheetId;
    setApplyingClassification(prev => ({ ...prev, [alertKey]: true }));
    setClassificationMsg(prev => ({ ...prev, [alertKey]: "" }));
    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "classify_pl_category",
          clientName,
          categoryName,
          classification,
          automationCommanderSheetId,
          masterSheetId: targetMasterSheetId,
          clientSheetId: targetClientSheetId,
          sessionId,
          alertKey,
          fingerprintHash: alert.fingerprintHash
        })
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to classify category");
      }
      setClassificationMsg(prev => ({ ...prev, [alertKey]: "✓ Applied and synced!" }));

      if (sessionId && alertKey) {
        fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "remove_alert", sessionId, alertId: alertKey }),
        }).catch(() => { });
      }

      setTimeout(() => {
        if (typeof acknowledgeProactiveAlert === "function") {
          acknowledgeProactiveAlert(alert.alertKey, alert.rowIndex);
        }
      }, 1000);
    } catch (err) {
      setClassificationMsg(prev => ({ ...prev, [alertKey]: `Error: ${err.message}` }));
    } finally {
      setApplyingClassification(prev => ({ ...prev, [alertKey]: false }));
    }
  };

  const handleSavePartPaidDate = async (alert) => {
    const alertKey = alert.alertKey;
    const m = alert.metadata || {};
    const defaultIso = m.isoTargetDate || toInputDateFormat(m.targetDate || alert.targetDate);
    const chosenDate = partPaidDates[alertKey] || defaultIso;
    if (!chosenDate) return;

    setUpdatingPartPaid(prev => ({ ...prev, [alertKey]: true }));
    setPartPaidMsg(prev => ({ ...prev, [alertKey]: "" }));

    try {
      const clientName = alert.clientName || selectedClient?.clientName;
      const clientInfo = (clientsWithFlags || []).find(c => c.clientName === clientName) || (allClientsMap && allClientsMap[clientName]);
      const targetClientSheetId = m.clientSheetId || clientInfo?.clientSheetId || selectedClient?.clientSheetId;
      const targetMasterSheetId = m.masterSheetId || clientInfo?.masterSheetId || selectedClient?.masterSheetId;

      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_part_paid_date",
          clientName,
          clientSheetId: targetClientSheetId,
          masterSheetId: targetMasterSheetId,
          itemType: m.itemType || alert.itemType || "invoice",
          rowNumber: m.confirmedRow || alert.confirmedRow,
          slot: m.slot || alert.slot,
          sendDate: m.sendDate || alert.sendDate,
          cellCoord: m.cellCoord || alert.cellCoord,
          appId: m.appId || alert.appId,
          newDate: chosenDate,
        })
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to update date");
      }

      setPartPaidMsg(prev => ({ ...prev, [alertKey]: `✓ Updated to ${data.formattedNewDate}!` }));
    } catch (err) {
      setPartPaidMsg(prev => ({ ...prev, [alertKey]: `Error: ${err.message}` }));
    } finally {
      setUpdatingPartPaid(prev => ({ ...prev, [alertKey]: false }));
    }
  };

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
                    <div key={label} style={{ marginBottom: "16px", width: "100%" }}>
                      <div style={{ fontSize: "11px", fontWeight: "700", color: "#888", textTransform: "uppercase", letterSpacing: "0.05em", padding: "6px 0 6px" }}>
                        {label}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: "10px", width: "100%" }}>
                        {alerts.map((alert, idx) => {
                          const selKey = alert.fingerprintHash || alert.alertKey || `${alert.flagType || alert.type}-${alert.sheetName}-${alert.rowNumber || idx}`;
                          return (
                            <button
                              className="triage-btn pma-alert-card"
                              key={selKey}
                              onClick={() => selectAlert(alert)}
                              style={{
                                ...styles.optionButton,
                                display: "block",
                                width: "100%",
                                boxSizing: "border-box",
                                textAlign: "left",
                                padding: "14px 16px",
                                border: "1px solid #cbd5e1",
                                borderRadius: "8px",
                                cursor: "pointer",
                                backgroundColor: "#fff",
                                fontSize: "13px",
                                transition: "all 0.2s"
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#f8fafc"; e.currentTarget.style.borderColor = "#2563eb"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "#fff"; e.currentTarget.style.borderColor = "#cbd5e1"; }}
                            >
                              {renderAlertContent(alert)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                  return (
                    <div>
                      {renderSubList(nonDrafts, "Sent / non-draft")}
                      {renderSubList(drafts, "Draft")}
                      {selectedClient && (
                        <div style={{ display: "flex", justifyContent: "flex-start", marginTop: "8px" }}>
                          <button
                            className="triage-btn"
                            onClick={() => onNavInvoices ? onNavInvoices(selectedClient) : setActiveNav("invoices")}
                            style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 14px", color: "#ea580c", borderColor: "#fdba74" }}
                          >
                            Assign invoices
                          </button>
                        </div>
                      )}
                    </div>
                  );
                }
                const isContractorExpenseGroup = type === "contractorsDashboardDiscr" || type === "expenseDashboardDiscr";
                const isPassThroughExpenseGroup = type === "passThroughDashboardDiscr";
                const isInvoiceGroup = type === "invoiceDashboardDiscr";
                return (
                  <>
                    {groupAlerts.map((alert, idx) => {
                      const selKey = alert.fingerprintHash || alert.alertKey || `${alert.flagType || alert.type}-${alert.sheetName}-${alert.rowNumber || idx}`;
                      return (
                        <button
                          className="triage-btn pma-alert-card"
                          key={selKey}
                          onClick={() => selectAlert(alert)}
                          style={{
                            ...styles.optionButton,
                            display: "block",
                            width: "100%",
                            boxSizing: "border-box",
                            textAlign: "left",
                            padding: "14px 16px",
                            border: "1px solid #cbd5e1",
                            borderRadius: "8px",
                            cursor: "pointer",
                            backgroundColor: "#fff",
                            fontSize: "13px",
                            transition: "all 0.2s"
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#f8fafc"; e.currentTarget.style.borderColor = "#2563eb"; }}
                          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "#fff"; e.currentTarget.style.borderColor = "#cbd5e1"; }}
                        >
                          {renderAlertContent(alert)}
                        </button>
                      );
                    })}
                    {isContractorExpenseGroup && selectedClient && (
                      <div style={{ display: "flex", justifyContent: "flex-start", marginTop: "4px" }}>
                        <button
                          className="triage-btn"
                          onClick={() => onNavOutgoings ? onNavOutgoings(selectedClient) : setActiveNav("outgoings")}
                          style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 14px", color: "#059669", borderColor: "#6ee7b7" }}
                        >
                          Assign contractor costs
                        </button>
                      </div>
                    )}
                    {isPassThroughExpenseGroup && selectedClient && (
                      <div style={{ display: "flex", justifyContent: "flex-start", marginTop: "4px" }}>
                        <button
                          className="triage-btn"
                          onClick={() => onNavPassThrough ? onNavPassThrough(selectedClient) : setActiveNav("passthrough")}
                          style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 14px", color: "#059669", borderColor: "#6ee7b7" }}
                        >
                          Assign pass-through costs
                        </button>
                      </div>
                    )}
                    {isInvoiceGroup && selectedClient && (
                      <div style={{ display: "flex", justifyContent: "flex-start", marginTop: "4px" }}>
                        <button
                          className="triage-btn"
                          onClick={() => onNavInvoices ? onNavInvoices(selectedClient) : setActiveNav("invoices")}
                          style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 14px", color: "#ea580c", borderColor: "#fdba74" }}
                        >
                          Assign invoices
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
        const groupAlerts = (groupedInfoAlerts[type] || []).filter(na => {
          const alertId = na.fingerprintHash || `${na.flagType}-${na.flagDetail || ""}`;
          return (
            !resolvedNoActionFlags.has(alertId) &&
            (!na.fingerprintHash || !resolvedNoActionFlags.has(na.fingerprintHash)) &&
            (!na.id || !resolvedNoActionFlags.has(na.id)) &&
            (!na.flagDetail || !resolvedNoActionFlags.has(`${na.flagType}-${na.flagDetail}`))
          );
        });
        if (groupAlerts.length === 0) return null;
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

                const parsed = parseInfoAlertDetail(na.flagType, na.flagDetail);
                const primaryResult = displayedResults[0] || null;
                const displayClient = parsed.client || primaryResult?.clientName || "";
                const displayJob = parsed.job || (primaryResult?.jobName && primaryResult.jobName !== "-" ? primaryResult.jobName : "") || "";
                const displayProjectCode = parsed.projectCode || primaryResult?.projectCode || "";
                const displayJobType = parsed.jobType || primaryResult?.jobType || "";
                const displayInvoiceAmount = parsed.invoiceAmount || primaryResult?.invoiceAmount || "";
                const displayRevenue = parsed.revenue || primaryResult?.revenue || "";
                const displayDirectCosts = parsed.directCosts || primaryResult?.directCosts || "";
                const displayStartDate = parsed.startDate || primaryResult?.startDate || "";
                const rawDisplayEndDate = parsed.endDate || primaryResult?.endDate || "";
                const displayEndDate = rawDisplayEndDate ? formatJobEndDateDisplay(rawDisplayEndDate, rawDisplayEndDate) : "";
                const cardTitle = getInfoCardTitle(na, parsed, getFlagName, false);

                const isExiting = exitingAlertKeys.has(alertId);
                return (
                  <div
                    key={alertId}
                    style={{
                      display: "grid",
                      gridTemplateRows: isExiting ? "0fr" : "1fr",
                      opacity: isExiting ? 0 : 1,
                      transform: isExiting ? "translateX(16px)" : "translateX(0)",
                      marginTop: isExiting ? "-10px" : 0,
                      transition: "grid-template-rows 300ms cubic-bezier(0.4, 0, 0.2, 1), margin-top 300ms cubic-bezier(0.4, 0, 0.2, 1), opacity 260ms ease, transform 260ms ease",
                      pointerEvents: isExiting ? "none" : "auto",
                      width: "100%",
                    }}
                  >
                    <div style={{ minHeight: 0, overflow: "hidden" }}>
                      <div className="non-admin-alert-card pma-alert-card" style={{
                        padding: "14px 16px",
                        borderRadius: "8px",
                        border: isExiting ? "1px solid #86efac" : "1px solid #cbd5e1",
                        background: isExiting ? "#f0fdf4" : "#ffffff",
                        display: "flex",
                        flexDirection: "column",
                        gap: "4px",
                        boxSizing: "border-box",
                        width: "100%",
                        transition: "background-color 200ms ease, border-color 200ms ease",
                      }}>
                        <div className="pma-alert-card-title" style={{
                          fontWeight: "600",
                          fontSize: "13.5px",
                          color: "#0f172a",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          flexWrap: "wrap",
                          gap: "8px",
                        }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", minWidth: 0 }}>
                            <span>{cardTitle}</span>
                          </div>
                        </div>

                        <div style={{
                          fontSize: "12px",
                          color: "#555",
                          display: "flex",
                          flexDirection: "column",
                          gap: "2px",
                          marginTop: "2px",
                        }}>
                          {parsed.tab && na.flagType !== "crmCopiedConfChecked" && na.flagType !== "invoiceStaleUnsentChanges" && <div><strong>Section:</strong> {parsed.tab}</div>}
                          {parsed.month && <div><strong>Month:</strong> {parsed.month}</div>}
                          {displayClient && <div><strong>End client:</strong> {displayClient}</div>}
                          {parsed.contractor && <div><strong>{parsed.tab === "Outgoings" ? "Vendor:" : "Contractor:"}</strong> {parsed.contractor}</div>}
                          {displayJob && <div><strong>Job:</strong> {displayJob}{displayProjectCode ? ` [${displayProjectCode}]` : ""}</div>}
                          {displayJobType && <div><strong>Job type:</strong> {displayJobType}</div>}
                          {displayInvoiceAmount && <div><strong>Invoice amount:</strong> {displayInvoiceAmount}</div>}
                          {displayRevenue && <div><strong>Revenue:</strong> {displayRevenue}</div>}
                          {displayDirectCosts && <div><strong>Direct costs:</strong> {displayDirectCosts}</div>}
                          {displayStartDate && <div><strong>Start date:</strong> {displayStartDate}</div>}
                          {displayEndDate && <div><strong>End date:</strong> {displayEndDate}</div>}
                          {parsed.amount && <div><strong>Amount:</strong> {parsed.amount}</div>}
                          {parsed.changes && parsed.changes.length > 0 && (
                            <div style={{ marginTop: "3px" }}>
                              <strong style={{ display: "block", marginBottom: "3px" }}>Date updates:</strong>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                                {parsed.changes.map((ch, ci) => (
                                  <span key={ci} style={{
                                    padding: "2px 7px", borderRadius: "4px", fontSize: "11px", fontWeight: "600",
                                    background: "#f1f5f9",
                                    color: "#334155",
                                    border: "1px solid #cbd5e1",
                                  }}>
                                    {ch.label}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                          {parsed.rawText && (
                            <div style={{ marginTop: "2px", color: "#666", lineHeight: "1.4" }}>
                              {stripRowInfo(parsed.rawText)}
                            </div>
                          )}
                        </div>

                        {analysis && !isLoading && (
                          <div style={{ marginTop: "2px" }}>
                            <div style={{
                              padding: "6px 10px", borderRadius: "4px", marginBottom: "8px", fontSize: "12px", fontWeight: "600",
                              background: overallOk ? "#e8f5e9" : "#fbe9e7", color: overallOk ? "#2e7d32" : "#bf360c",
                              border: `1px solid ${overallOk ? "#c8e6c9" : "#ffccbc"}`
                            }}>
                              {overallOk ? "✓ Everything looks correct" : "⚠ Issues found - review below"}
                            </div>
                            {(analysis.results || []).map((r, ri) => (
                              <div key={ri} style={{
                                marginBottom: "8px", padding: "8px 10px", borderRadius: "4px",
                                border: `1px solid ${r.status === "ok" ? "#c8e6c9" : r.status === "issue" ? "#ffccbc" : "#e0e0e0"}`,
                                background: "#ffffff",
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
                        {analysis && !analysis.success && (
                          <div style={{ fontSize: "12px", color: "#c62828", marginTop: "4px" }}>Error: {analysis.error}</div>
                        )}

                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px", marginTop: "6px" }}>
                          <div style={{ fontSize: "11px", color: "#888" }}>
                            {na.firstSeen ? `First seen: ${formatSeenTimestamp(na.firstSeen)}` : ""}
                            {na.firstSeen && na.lastSeen ? " · " : ""}
                            {na.lastSeen ? `Last seen: ${formatSeenTimestamp(na.lastSeen)}` : ""}
                          </div>
                          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                            {isRichFlag && !analysis && !isLoading && (
                              <button className="triage-btn"
                                onClick={() => analyzeNoActionFlag(na)}
                                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px" }}
                              >
                                🔍 Analyse
                              </button>
                            )}
                            {isRichFlag && isLoading && (
                              <span style={{ fontSize: "12px", color: "#888", padding: "4px 12px", display: "inline-flex", alignItems: "center", gap: "6px" }}><Spinner size={12} />Analysing…</span>
                            )}
                            {isRichFlag && analysis && !isLoading && (
                              <button className="triage-btn"
                                onClick={() => analyzeNoActionFlag(na)}
                                style={{ ...styles.buttonSecondary, fontSize: "11px", padding: "4px 8px" }}
                              >
                                ↻ Re-run
                              </button>
                            )}
                            {(() => {
                              const cName = na.clientName || selectedClient?.clientName;
                              const clientInfo = (clientsWithFlags || []).find(c => c.clientName === cName) || (allClientsMap && (allClientsMap[cName] || Object.values(allClientsMap).find(cl => cl.clientName?.toLowerCase() === cName?.toLowerCase()))) || selectedClient || { clientName: cName };
                              const jobTarget = getAlertJobTarget(na, true, clientInfo);
                              if (!jobTarget || !onViewJob) return null;
                              return (
                                <button
                                  className="triage-btn pma-alert-card"
                                  onClick={() => onViewJob(jobTarget)}
                                  style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#0284c7", borderColor: "#bae6fd" }}
                                  title={jobTarget.isOutgoings ? "View overhead expense details" : "View and edit job details in pop-up"}
                                >
                                  {jobTarget.isOutgoings ? "View expense" : "View job"}
                                </button>
                              );
                            })()}
                            <button className="triage-btn"
                              onClick={() => openCreateTaskModal(na, false, true)}
                              style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#7c3aed", borderColor: "#c4b5fd", whiteSpace: "nowrap" }}
                            >
                              Create task
                            </button>
                            <button className="triage-btn no-click-spinner"
                              onClick={() => handleMarkNoActionResolved(na)}
                              disabled={isExiting}
                              style={{
                                ...styles.buttonSecondary,
                                fontSize: "12px",
                                padding: "4px 12px",
                                whiteSpace: "nowrap",
                                ...(isExiting ? { color: "#16a34a", borderColor: "#86efac", background: "#f0fdf4" } : {})
                              }}
                            >
                              {isExiting ? "Acknowledged" : "Acknowledge"}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
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
                const cardKey = alert.alertKey || (alert.rowIndex != null ? `proactive-row-${alert.rowIndex}` : `proactive-${idx}`);
                const activeKey = alert.alertKey || (alert.rowIndex != null ? `row-${alert.rowIndex}` : null);
                const isExiting = exitingAlertKeys.has(cardKey) || (activeKey && exitingAlertKeys.has(activeKey));
                return (
                  <div
                    key={cardKey}
                    style={{
                      display: "grid",
                      gridTemplateRows: isExiting ? "0fr" : "1fr",
                      opacity: isExiting ? 0 : 1,
                      transform: isExiting ? "translateX(16px)" : "translateX(0)",
                      marginTop: isExiting ? "-12px" : 0,
                      transition: "grid-template-rows 300ms cubic-bezier(0.4, 0, 0.2, 1), margin-top 300ms cubic-bezier(0.4, 0, 0.2, 1), opacity 260ms ease, transform 260ms ease",
                      pointerEvents: isExiting ? "none" : "auto",
                      width: "100%",
                    }}
                  >
                    <div style={{ minHeight: 0, overflow: "hidden" }}>
                      <div className="non-admin-alert-card pma-alert-card" style={{ border: isExiting ? "1px solid #86efac" : "1px solid #cbd5e1", borderRadius: "8px", padding: "14px 16px", backgroundColor: isExiting ? "#f0fdf4" : "#ffffff", boxSizing: "border-box", width: "100%", display: "flex", flexDirection: "column", gap: "4px", transition: "background-color 200ms ease, border-color 200ms ease" }}>
                        <div className="pma-alert-card-title" style={{ fontWeight: "600", fontSize: "13.5px", color: "#0f172a", marginBottom: "2px", wordBreak: "break-word" }}>
                          {getProactiveCardTitle(alert, false)}
                        </div>

                        {alert.alertType === "retainer_invoice" && (() => {
                          const jobName = m.jobName || alert.jobName;
                          const endClientName = m.endClientName || alert.endClientName;
                          const revenue = m.revenue || alert.revenue;
                          const startDate = m.startDate || alert.startDate;
                          const endDate = m.endDate || alert.endDate;
                          const frequencyDays = m.frequencyDays || alert.frequencyDays;
                          const lastInvoiceDate = m.lastInvoiceDate || alert.lastInvoiceDate;
                          const expectedByDate = m.expectedByDate || alert.expectedByDate;
                          const possibleMatchInvoiceNo = m.possibleMatchInvoiceNo || alert.possibleMatchInvoiceNo;
                          const possibleMatchAmount = m.possibleMatchAmount || alert.possibleMatchAmount;
                          const possibleMatchSentDate = m.possibleMatchSentDate || alert.possibleMatchSentDate;
                          const possibleMatchConfidence = m.possibleMatchConfidence || alert.possibleMatchConfidence;
                          const possibleMatchConfirmedRow = m.possibleMatchConfirmedRow || alert.possibleMatchConfirmedRow;
                          const possibleMatchStatus = m.possibleMatchStatus || alert.possibleMatchStatus;
                          const effectiveMatchCase = m.possibleMatchCase || alert.possibleMatchCase || (
                            possibleMatchInvoiceNo
                              ? ((possibleMatchAmount && revenue && Math.abs(parseFloat(possibleMatchAmount || 0) - parseFloat(revenue || 0)) > 0.01) ? "changed" : (possibleMatchStatus && !["sent", "paid"].includes(String(possibleMatchStatus).toLowerCase()) ? "draft" : "matches"))
                              : ""
                          );
                          return (
                            <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                              {endClientName && <div><strong>End client:</strong> {endClientName}</div>}
                              {jobName && <div><strong>Job:</strong> {jobName}</div>}
                              {revenue && <div><strong>Monthly revenue:</strong> {revenue}</div>}
                              {startDate && <div><strong>Contract period:</strong> {startDate} → {formatJobEndDateDisplay(endDate, endDate)}</div>}
                              {frequencyDays && <div><strong>Invoice frequency:</strong> {freqLabel(frequencyDays)} (every ~{frequencyDays} days)</div>}
                              {lastInvoiceDate && <div><strong>Last invoice sent:</strong> {lastInvoiceDate}</div>}
                              {expectedByDate && <div><strong>Next expected by:</strong> {expectedByDate}</div>}
                              {possibleMatchInvoiceNo && (
                                <div style={{ marginTop: "6px", paddingTop: "6px", borderTop: "1px solid #e2e8f0" }}>
                                  {effectiveMatchCase === "changed" && (
                                    <div style={{ display: "inline-block", padding: "1px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "600", marginBottom: "4px", background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca" }}>
                                      Possible retainer change - {possibleMatchConfidence === "high" ? "high" : "medium"} confidence
                                    </div>
                                  )}
                                  {effectiveMatchCase === "draft" && (
                                    <div style={{ display: "inline-block", padding: "1px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "600", marginBottom: "4px", background: "#f0f9ff", color: "#0369a1", border: "1px solid #bae6fd" }}>
                                      Draft invoice found nearby
                                    </div>
                                  )}
                                  <div><strong>{effectiveMatchCase === "draft" ? "DRAFT invoice found:" : "Invoice found:"}</strong> #{possibleMatchInvoiceNo} for £{parseFloat(possibleMatchAmount || 0).toFixed(2)}, sent {possibleMatchSentDate}</div>
                                  <div>{possibleMatchConfirmedRow ? <>Already attached to a confirmed job</> : <>Not yet attached to any confirmed job</>}</div>
                                  {effectiveMatchCase === "changed" && <div style={{ marginTop: "4px" }}>This may mean the retainer value has changed.</div>}
                                  {effectiveMatchCase === "matches" && <div style={{ marginTop: "4px" }}>Matches the expected retainer amount.</div>}
                                  {effectiveMatchCase === "draft" && <div style={{ marginTop: "4px" }}>It likely just needs sending.</div>}
                                </div>
                              )}
                              {jobName && (
                                <div style={{ marginTop: "8px", paddingTop: "8px", borderTop: "1px solid #e2e8f0", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                                  {possibleMatchInvoiceNo ? (
                                    <>
                                      <button className="triage-btn" onClick={() => {
                                        const clientInfo = getClientInfoForAlert(alert);
                                        const targetClientSheetId = clientInfo?.clientSheetId || selectedClient?.clientSheetId || m.clientSheetId || alert.clientSheetId;
                                        const targetMasterSheetId = clientInfo?.masterSheetId || selectedClient?.masterSheetId || m.masterSheetId || alert.masterSheetId;
                                        const targetClientName = alert.clientName || selectedClient?.clientName || "";
                                        setRetainerAlertResolution({
                                          resolutionType: "changeAmount",
                                          alertMeta: {
                                            ...alert,
                                            ...m,
                                            jobName,
                                            endClientName,
                                            lastInvoiceDate,
                                            possibleMatchSentDate,
                                            possibleMatchAmount,
                                            possibleMatchInvoiceNo,
                                            possibleMatchConfirmedRow,
                                            clientName: targetClientName
                                          },
                                          alertKey: alert.alertKey,
                                          clientSheetId: targetClientSheetId,
                                          masterSheetId: targetMasterSheetId
                                        });
                                      }} style={{ padding: "6px 12px", background: "#1976d2", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>Change retainer amount</button>
                                      <button className="triage-btn" onClick={() => {
                                        const clientInfo = getClientInfoForAlert(alert);
                                        const targetClientSheetId = clientInfo?.clientSheetId || selectedClient?.clientSheetId || m.clientSheetId || alert.clientSheetId;
                                        const targetMasterSheetId = clientInfo?.masterSheetId || selectedClient?.masterSheetId || m.masterSheetId || alert.masterSheetId;
                                        const targetClientName = alert.clientName || selectedClient?.clientName || "";
                                        setRetainerSplitInvoice({
                                          alertMeta: {
                                            ...alert,
                                            ...m,
                                            jobName,
                                            endClientName,
                                            lastInvoiceDate,
                                            possibleMatchSentDate,
                                            possibleMatchAmount,
                                            possibleMatchInvoiceNo,
                                            possibleMatchConfirmedRow,
                                            clientName: targetClientName
                                          },
                                          alertKey: alert.alertKey,
                                          clientSheetId: targetClientSheetId,
                                          masterSheetId: targetMasterSheetId
                                        });
                                      }} style={{ padding: "6px 12px", background: "#0284c7", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>Split invoice</button>
                                    </>
                                  ) : (
                                    <button className="triage-btn" onClick={() => {
                                      const clientInfo = getClientInfoForAlert(alert);
                                      const targetClientSheetId = clientInfo?.clientSheetId || selectedClient?.clientSheetId || m.clientSheetId || alert.clientSheetId;
                                      const targetMasterSheetId = clientInfo?.masterSheetId || selectedClient?.masterSheetId || m.masterSheetId || alert.masterSheetId;
                                      const targetClientName = alert.clientName || selectedClient?.clientName || "";
                                      setRetainerAlertResolution({
                                        resolutionType: "end",
                                        alertMeta: {
                                          ...alert,
                                          ...m,
                                          jobName,
                                          endClientName,
                                          lastInvoiceDate,
                                          clientName: targetClientName
                                        },
                                        alertKey: alert.alertKey,
                                        clientSheetId: targetClientSheetId,
                                        masterSheetId: targetMasterSheetId
                                      });
                                    }} style={{ padding: "6px 12px", background: "#dc2626", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>End retainer</button>
                                  )}
                                  {setRetainerChangeSendDates && (
                                    <button
                                      className="triage-btn"
                                      onClick={() => {
                                        const clientInfo = getClientInfoForAlert(alert);
                                        const targetClientSheetId = clientInfo?.clientSheetId || selectedClient?.clientSheetId || m.clientSheetId || alert.clientSheetId;
                                        const targetMasterSheetId = clientInfo?.masterSheetId || selectedClient?.masterSheetId || m.masterSheetId || alert.masterSheetId;
                                        const targetClientName = alert.clientName || selectedClient?.clientName || "";
                                        setRetainerChangeSendDates({
                                          alert,
                                          alertMeta: {
                                            ...alert,
                                            ...m,
                                            jobName,
                                            endClientName,
                                            clientName: targetClientName
                                          },
                                          clientName: targetClientName,
                                          endClientName,
                                          jobName,
                                          confirmedRow: m.confirmedRow || alert.confirmedRow,
                                          clientSheetId: targetClientSheetId,
                                          masterSheetId: targetMasterSheetId
                                        });
                                      }}
                                      style={{ padding: "6px 12px", background: "#0284c7", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}
                                    >
                                      Change send dates
                                    </button>
                                  )}
                                  {(() => {
                                    const cName = alert.clientName || selectedClient?.clientName;
                                    const clientInfo = (clientsWithFlags || []).find(c => c.clientName === cName) || (allClientsMap && (allClientsMap[cName] || Object.values(allClientsMap).find(cl => cl.clientName?.toLowerCase() === cName?.toLowerCase()))) || selectedClient || { clientName: cName };
                                    const jobTarget = getAlertJobTarget(alert, false, clientInfo);
                                    if (!jobTarget || !onViewJob) return null;
                                    return (
                                      <button
                                        className="triage-btn"
                                        onClick={() => onViewJob(jobTarget)}
                                        style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 12px", color: "#0284c7", borderColor: "#bae6fd", display: "inline-flex", alignItems: "center", gap: "4px" }}
                                        title="View and edit job details in pop-up"
                                      >
                                        🔍 View job
                                      </button>
                                    );
                                  })()}
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {alert.alertType === "uninvoiced_new_job" && (() => {
                          const displayEndDate = m.endDate || alert.endDate || alert.detail?.match(/ends\s+([0-9a-zA-Z-]+)/i)?.[1];
                          return (
                            <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                              {m.endClientName && <div><strong>End client:</strong> {m.endClientName}</div>}
                              {m.jobName && <div><strong>Job:</strong> {m.jobName}{m.projectCode ? ` [${m.projectCode}]` : ""}</div>}
                              {(m.jobType || alert.jobType || m.isRetainer !== undefined) && (
                                <div><strong>Job type:</strong> {m.jobType || alert.jobType || (String(m.isRetainer).toLowerCase() === "true" || String(m.isRetainer).toLowerCase() === "yes" ? "Retainer" : "Project")}</div>
                              )}
                              {m.startDate && <div><strong>Job started:</strong> {m.startDate}</div>}
                              {displayEndDate && <div><strong>Job end date:</strong> {formatJobEndDateDisplay(displayEndDate, displayEndDate)}</div>}
                              {m.revenue && <div><strong>Revenue:</strong> £{parseFloat(m.revenue).toFixed(2)}</div>}
                              <div style={{ marginTop: "4px", color: "#c62828" }}>Over a month elapsed with zero real invoices sent.</div>
                            </div>
                          );
                        })()}

                        {alert.alertType === "uninvoiced_revenue" && (
                          <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                            {m.endClientName && <div><strong>End client:</strong> {m.endClientName}</div>}
                            {m.jobName && <div><strong>Job:</strong> {m.jobName}{m.projectCode ? ` [${m.projectCode}]` : ""}</div>}
                            {m.endDate && <div><strong>Job ended:</strong> {formatJobEndDateDisplay(m.endDate, m.endDate)}</div>}
                            {m.revenue && <div><strong>Revenue:</strong> £{parseFloat(m.revenue).toFixed(2)}</div>}
                            {m.uninvoicedAmount && <div style={{ marginTop: "4px", fontWeight: "600", color: "#c62828" }}>£{parseFloat(m.uninvoicedAmount).toFixed(2)} uninvoiced (placeholders and drafts excluded)</div>}
                            {m.draftCount && parseInt(m.draftCount) > 0 && <div style={{ marginTop: "4px", color: "#d97706" }}>{m.draftCount} invoice{parseInt(m.draftCount) > 1 ? "s" : ""} totalling £{parseFloat(m.draftTotal || 0).toFixed(2)} {parseInt(m.draftCount) > 1 ? "have" : "has"} a reference but {parseInt(m.draftCount) > 1 ? "are" : "is"} still <strong>Draft</strong> (not yet sent) - not counted as invoiced above.</div>}
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
                            <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                              {clientName && <div><strong>End client:</strong> {clientName}</div>}
                              {jName && <div><strong>Job:</strong> {jName}{pCode ? ` [${pCode}]` : ""}</div>}
                              {eDate && <div><strong>Job ended:</strong> {formatJobEndDateDisplay(eDate, eDate)}</div>}
                              {dCosts && <div><strong>Direct cost budget:</strong> £{parseFloat(dCosts).toFixed(2)}</div>}
                              {unrecAmt && <div style={{ marginTop: "4px", fontWeight: "600", color: "#c62828" }}>£{parseFloat(unrecAmt).toFixed(2)} unreceived (placeholders and estimates excluded)</div>}
                              {pCount > 0 && (
                                <div style={{ marginTop: "4px", color: "#d97706" }}>
                                  {pCount} expense{pCount > 1 ? "s" : ""} totalling £{pTotal.toFixed(2)} {pCount > 1 ? "are placeholders - not counted as received above." : "is a placeholder - not counted as received above."}
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {alert.alertType === "stale_unrecon_gap" && (() => {
                          const contractor = m.contractor || alert.contractor;
                          const cellCoord = m.cellCoord || alert.cellCoord;
                          const month = m.month || alert.month;
                          const amount = m.amount || alert.amount;
                          const recDate = m.recDate || alert.recDate;
                          const payDate = m.payDate || alert.payDate;
                          const weeksAgo = m.weeksAgo || alert.weeksAgo;
                          const appId = m.appId || alert.appId;
                          const desc = m.description || alert.description;

                          return (
                            <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                              {contractor && <div><strong>Contractor:</strong> {contractor}</div>}
                              <div><strong>Location:</strong> Outgoings{month ? ` (${month})` : ""}</div>
                              {appId && <div><strong>App ID:</strong> {appId}</div>}
                              {amount && <div><strong>Amount:</strong> £{parseFloat(amount).toFixed(2)}</div>}
                              {recDate && <div><strong>Received date:</strong> {recDate} {weeksAgo ? <span style={{ color: "#b45309", fontWeight: "600" }}>({weeksAgo} weeks ago - overdue)</span> : null}</div>}
                              {payDate && <div><strong>Estimated pay date:</strong> {payDate}</div>}
                              {desc && <div style={{ marginTop: "2px", color: "#78716c", fontStyle: "italic" }}>{desc}</div>}
                            </div>
                          );
                        })()}

                        {alert.alertType === "retroactive_outgoings_update" && (() => {
                          const detailRaw = alert.detail || alert.detailsSnippet || m.details || "";
                          const parsed = parseRetroactiveOutgoingsDetail(detailRaw);
                          const isExpanded = !!expandedAutoLogAlerts[alert.alertKey];

                          return (
                            <div style={{ fontSize: "12px", color: "#555", marginTop: "2px", marginBottom: "4px", lineHeight: "1.4" }}>
                              <div style={{ whiteSpace: "pre-line" }}>
                                {parsed.basicLines.map(l => (l.match(/^\s*/)?.[0] || "") + sanitizeSpreadsheetTerms(l.trim())).join("\n")}
                              </div>

                              {parsed.hasMoreDetails && (
                                <div style={{ marginTop: "6px" }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                                    <button
                                      type="button"
                                      className="triage-btn"
                                      onClick={() => setExpandedAutoLogAlerts(prev => ({ ...prev, [alert.alertKey]: !prev[alert.alertKey] }))}
                                      style={{
                                        fontSize: "11px",
                                        padding: "2px 8px",
                                        color: "#6366f1",
                                        borderColor: "#c7d2fe",
                                        background: "#f5f7ff",
                                        cursor: "pointer",
                                        borderRadius: "4px"
                                      }}
                                    >
                                      {isExpanded ? "Hide full log details ▴" : "View full log details ▾"}
                                    </button>
                                    <button
                                      type="button"
                                      className="triage-btn"
                                      onClick={() => setAutoLogModalAlert(alert)}
                                      style={{
                                        fontSize: "11px",
                                        padding: "2px 8px",
                                        color: "#475569",
                                        borderColor: "#cbd5e1",
                                        background: "#f8fafc",
                                        cursor: "pointer",
                                        borderRadius: "4px"
                                      }}
                                    >
                                      Open in modal ↗
                                    </button>
                                  </div>

                                  {isExpanded && (
                                    <div style={{
                                      fontFamily: "monospace",
                                      fontSize: "11px",
                                      color: "#334155",
                                      backgroundColor: "#f8fafc",
                                      border: "1px solid #e2e8f0",
                                      borderRadius: "4px",
                                      padding: "6px 8px",
                                      marginTop: "6px",
                                      whiteSpace: "pre-wrap",
                                      wordBreak: "break-word",
                                      maxHeight: "220px",
                                      overflowY: "auto"
                                    }}>
                                      {parsed.fullText.split(/\r?\n/).map(l => (l.match(/^\s*/)?.[0] || "") + sanitizeSpreadsheetTerms(l.trim())).join("\n")}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {alert.alertType === "unmapped_pl_category" && (() => {
                          const catName = alert.metadata?.categoryName || alert.metadata?.cleanName || alert.heading;
                          const cleanCatName = String(catName || "")
                            .replace(/^["“]+|["”]+$/g, "")
                            .replace(/^unmapped\s+p&l\s+(?:category|account):\s*["“]?/i, "")
                            .replace(/^["“]+|["”]+$/g, "")
                            .replace(/^\d+\s*[-–]\s*/, "")
                            .toLowerCase()
                            .trim();
                          const isOtherExpenses = /^other\s+expenses?$/i.test(cleanCatName);
                          const plSectionType = alert.metadata?.plSectionType || alert.plSectionType;
                          const plSection = alert.metadata?.plSection || alert.plSection;
                          const suggestedChoice = isOtherExpenses
                            ? "non_delivery_expense"
                            : (alert.metadata?.suggestedClassification || alert.suggestedClassification || "delivery_expense");
                          const currentChoice = selectedClassifications[alert.alertKey] || suggestedChoice;
                          const isApplying = !!applyingClassification[alert.alertKey];
                          const msg = classificationMsg[alert.alertKey];

                          const OPTIONS = [
                            { value: "delivery_expense", label: "Delivery expense (other costs of sale)" },
                            { value: "non_delivery_expense", label: "Non-delivery expense (overheads)" },
                            { value: "revenue", label: "Revenue" },
                            { value: "cos_staff", label: "CoS staff cost" },
                            { value: "non_cos_staff", label: "Non-CoS staff cost" },
                            { value: "contractor", label: "Track as a contractor" },
                            { value: "corporation_tax", label: "Corporation tax" },
                            { value: "depreciation", label: "Depreciation" },
                            { value: "non_operating_income", label: "Non-operating income" },
                            { value: "non_operating_expense", label: "Non-operating expense" },
                            { value: "ignore", label: "Ignore entirely" }
                          ];

                          return (
                            <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "4px", marginTop: "2px", marginBottom: "4px" }}>
                              {plSectionType && (
                                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "2px", marginBottom: "2px" }}>
                                  <strong style={{ color: "#374151" }}>P&L section:</strong>
                                  <span style={{
                                    display: "inline-block",
                                    padding: "2px 8px",
                                    borderRadius: "4px",
                                    fontSize: "11px",
                                    fontWeight: "600",
                                    backgroundColor: plSectionType.includes("Cost of sale") ? "#fef3c7" : plSectionType.includes("Operating") ? "#e0e7ff" : plSectionType.includes("Revenue") ? "#dcfce7" : "#f1f5f9",
                                    color: plSectionType.includes("Cost of sale") ? "#92400e" : plSectionType.includes("Operating") ? "#3730a3" : plSectionType.includes("Revenue") ? "#166534" : "#475569",
                                    border: "1px solid",
                                    borderColor: plSectionType.includes("Cost of sale") ? "#fde68a" : plSectionType.includes("Operating") ? "#c7d2fe" : plSectionType.includes("Revenue") ? "#bbf7d0" : "#cbd5e1"
                                  }}>
                                    {plSectionType}
                                  </span>
                                  {plSection && plSection.toLowerCase() !== plSectionType.toLowerCase() && (
                                    <span style={{ fontSize: "11px", color: "#6b7280" }}>({plSection})</span>
                                  )}
                                </div>
                              )}

                              <div style={{ color: "#4b5563", lineHeight: "1.4" }}>
                                This account is currently quarantined to ensure unverified expenses are not included. Select how it should be mapped:
                              </div>

                              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px", marginTop: "4px" }}>
                                <select
                                  value={currentChoice}
                                  onChange={(e) => setSelectedClassifications(prev => ({ ...prev, [alert.alertKey]: e.target.value }))}
                                  disabled={isApplying}
                                  style={{
                                    padding: "6px 10px",
                                    fontSize: "12px",
                                    fontWeight: "500",
                                    borderRadius: "6px",
                                    border: "1px solid #c4b5fd",
                                    backgroundColor: "#fff",
                                    color: "#1f2937",
                                    minWidth: "200px",
                                    maxWidth: "100%",
                                    boxSizing: "border-box",
                                    cursor: "pointer"
                                  }}
                                >
                                  {OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                  ))}
                                </select>

                                <button
                                  className="triage-btn pma-alert-card"
                                  onClick={() => handleApplyPLClassification(alert)}
                                  disabled={isApplying}
                                  style={{
                                    background: "#7c3aed",
                                    color: "#fff",
                                    border: "none",
                                    borderRadius: "6px",
                                    padding: "6px 14px",
                                    fontSize: "12px",
                                    fontWeight: "600",
                                    cursor: isApplying ? "default" : "pointer",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "6px",
                                    opacity: isApplying ? 0.7 : 1,
                                    whiteSpace: "nowrap"
                                  }}
                                >
                                  {isApplying ? <><Spinner size={12} /> Confirming &amp; syncing...</> : "Confirm & apply"}
                                </button>

                                {msg && (
                                  <span style={{ fontSize: "12px", fontWeight: "600", color: msg.startsWith("✓") ? "#16a34a" : "#dc2626" }}>
                                    {msg}
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })()}

                        {alert.alertType === "crm_wipe" && (
                          <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                            {m.timestamp && <div><strong>Log timestamp:</strong> {m.timestamp}</div>}
                            {m.sequenceType && <div><strong>Sequence:</strong> {m.sequenceType}</div>}
                            {m.summary && <div><strong>Summary:</strong> {m.summary}</div>}
                            {m.jobInfo && <div><strong>Job:</strong> {m.jobInfo}</div>}
                            {m.detailsSnippet && <div style={{ marginTop: "4px" }}><strong>AutoLog details:</strong><div style={{ fontFamily: "monospace", fontSize: "11px", color: "#666", backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "4px", padding: "6px 8px", marginTop: "2px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.detailsSnippet}</div></div>}
                          </div>
                        )}

                        {alert.alertType === "revenue_mismatch" && (() => {
                          const parsed = (!m.revenue && !alert.revenue && alert.detail) ? parseRevenueMismatchDetail(alert.detail) : {};
                          const clientName = m.endClientName || alert.endClientName || parsed.endClientName;
                          const jName = m.jobName || alert.jobName || parsed.jobName;
                          const pCode = m.projectCode || alert.projectCode || parsed.projectCode;
                          const rawEDate = m.endDate || alert.endDate || parsed.endDate;
                          const eDate = rawEDate ? (isNoEndDateSentinel(rawEDate) ? formatJobEndDateDisplay(rawEDate) : toSheetDateFormat(rawEDate)) : "";
                          const parsedEnd = eDate && !isNoEndDateSentinel(rawEDate) ? parseSheetDate(eDate) : null;
                          const todayMid = new Date();
                          todayMid.setHours(0, 0, 0, 0);
                          const endLabel = isNoEndDateSentinel(rawEDate) || (parsedEnd && parsedEnd > todayMid) ? "Job ends:" : "Job ended:";
                          const rev = m.revenue || alert.revenue || parsed.revenue;
                          const inv = m.totalInvoiced || alert.totalInvoiced || parsed.totalInvoiced;
                          const diff = m.diff || alert.diff || parsed.diff;

                          return (
                            <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                              {clientName && <div><strong>End client:</strong> {clientName}</div>}
                              {jName && <div><strong>Job:</strong> {jName}{pCode ? ` [${pCode}]` : ""}</div>}
                              {eDate && <div><strong>{endLabel}</strong> {eDate}</div>}
                              {rev && <div><strong>Revenue budget:</strong> £{parseFloat(rev).toFixed(2)}</div>}
                              {inv && <div><strong>Total invoiced:</strong> £{parseFloat(inv).toFixed(2)}</div>}
                              {diff && <div style={{ marginTop: "4px", fontWeight: "600", color: "#c62828" }}>Difference: £{parseFloat(diff).toFixed(2)}</div>}
                            </div>
                          );
                        })()}

                        {alert.alertType === "direct_costs_mismatch" && (() => {
                          const parsed = (!m.directCosts && !alert.directCosts && alert.detail) ? parseDirectCostsMismatchDetail(alert.detail) : {};
                          const tabName = m.tab || alert.tab || parsed.tab || "Confirmed";
                          const clientName = m.endClientName || alert.endClientName || parsed.endClientName;
                          const jName = m.jobName || alert.jobName || parsed.jobName;
                          const pCode = m.projectCode || alert.projectCode || parsed.projectCode;
                          const rawEDate = m.endDate || alert.endDate || parsed.endDate;
                          const eDate = rawEDate ? (isNoEndDateSentinel(rawEDate) ? formatJobEndDateDisplay(rawEDate) : toSheetDateFormat(rawEDate)) : "";
                          const parsedEnd = eDate && !isNoEndDateSentinel(rawEDate) ? parseSheetDate(eDate) : null;
                          const todayMid = new Date();
                          todayMid.setHours(0, 0, 0, 0);
                          const endLabel = isNoEndDateSentinel(rawEDate) || (parsedEnd && parsedEnd > todayMid) ? "Job ends:" : "Job ended:";
                          const dCosts = m.directCosts || alert.directCosts || parsed.directCosts;
                          const expenses = m.totalExpenses || alert.totalExpenses || parsed.totalExpenses || m.childExp || alert.childExp;
                          const diff = m.diff || alert.diff || parsed.diff;

                          return (
                            <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                              {tabName && tabName !== "Confirmed" && (
                                <span style={{ display: "inline-block", marginBottom: "4px", padding: "2px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "600", background: "#f0f9ff", color: "#0369a1", border: "1px solid #bae6fd", width: "fit-content" }}>
                                  {tabName}
                                </span>
                              )}
                              {clientName && <div><strong>End client:</strong> {clientName}</div>}
                              {jName && <div><strong>Job:</strong> {jName}{pCode ? ` [${pCode}]` : ""}</div>}
                              {eDate && <div><strong>{endLabel}</strong> {eDate}</div>}
                              {dCosts && <div><strong>Direct cost budget:</strong> £{parseFloat(dCosts).toFixed(2)}</div>}
                              {expenses && <div><strong>Total expenses:</strong> £{parseFloat(expenses).toFixed(2)}</div>}
                              {diff && <div style={{ marginTop: "4px", fontWeight: "600", color: "#c62828" }}>Difference: £{parseFloat(diff).toFixed(2)}</div>}
                            </div>
                          );
                        })()}

                        {alert.alertType === "pipeline_confirmed_overlap" && (() => {
                          const md = alert.metadata || {};
                          return (
                            <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                              <div style={{ marginBottom: "2px" }}><strong>Confirmed jobs</strong></div>
                              {md.endClientName && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Client: {md.endClientName}</div>}
                              {md.jobName && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Job: {md.jobName}</div>}
                              {md.projectCode && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Project code: {md.projectCode}</div>}
                              {md.jobType && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Job type: {md.jobType}</div>}
                              <div style={{ marginBottom: "2px", marginTop: "4px" }}><strong>Pipeline jobs</strong></div>
                              <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Likelihood: <strong>{md.likelihood ? (parseFloat(md.likelihood) * 100).toFixed(0) + "%" : "(blank)"}</strong></div>
                              <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>&quot;Copied to confirmed?&quot;: <strong>{md.copiedToConf || "(blank)"}</strong></div>
                              <div style={{ marginTop: "4px", color: "#0369a1", fontStyle: "italic" }}>Expected fix: set Pipeline likelihood to 0% or mark &quot;Copied to confirmed?&quot; as Yes.</div>
                            </div>
                          );
                        })()}

                        {alert.alertType === "retainer_shrink_blocked" && (() => {
                          const md = alert.metadata || {};
                          return (
                            <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                              {md.clientJobStr && <div style={{ marginBottom: "2px" }}><strong>Job:</strong> {md.clientJobStr}</div>}
                              {md.timestamp && <div style={{ marginBottom: "4px" }}><strong>First detected:</strong> {String(md.timestamp).slice(0, 10)}</div>}
                              <div style={{ color: "#0369a1", fontStyle: "italic" }}>A billing period falls outside the new contract period but contains actuals (invoices or expenses) so cannot be auto-removed. Manual review required.</div>
                            </div>
                          );
                        })()}

                        {alert.alertType === "autolog_error" && (() => {
                          const md = alert.metadata || {};
                          const fullDetails = md.detailsSnippet || md.rawSnippet;
                          return (
                            <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                              {md.category && <div style={{ marginBottom: "2px" }}><strong>Category / step:</strong> {md.category}</div>}
                              {md.occurrenceCount && <div style={{ marginBottom: "2px" }}><strong>Occurrences (last 100 log rows):</strong> {md.occurrenceCount}</div>}
                              {md.timestamp && <div style={{ marginBottom: "2px" }}><strong>Last seen in log:</strong> {md.timestamp}</div>}
                              {md.errorSnippet && (
                                <div style={{ marginTop: "4px" }}>
                                  <strong>Extracted error:</strong>
                                  <div style={{ fontFamily: "monospace", fontSize: "11px", color: "#0369a1", backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "4px", padding: "6px 8px", marginTop: "2px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                                    {md.errorSnippet}
                                  </div>
                                </div>
                              )}
                              {fullDetails && fullDetails.trim() !== (md.errorSnippet || "").trim() && (
                                <div style={{ marginTop: "4px" }}>
                                  <strong>AutoLog details:</strong>
                                  <div style={{ fontFamily: "monospace", fontSize: "11px", color: "#666", backgroundColor: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "4px", padding: "6px 8px", marginTop: "2px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                                    {fullDetails}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {alert.alertType === "infinite_loop" && (() => {
                          const md = alert.metadata || {};
                          return (
                            <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                              <div style={{ display: "inline-block", padding: "1px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "600", marginBottom: "4px", background: "#f0f9ff", color: "#0369a1", border: "1px solid #bae6fd", width: "fit-content" }}>
                                {md.conflictType === "intra_run_oscillation" ? "Within-run oscillation" : "Multi-run flip-flop"}
                              </div>
                              {md.invoiceNo && <div style={{ marginBottom: "2px" }}><strong>Invoice:</strong> {md.invoiceNo}</div>}
                              {md.fieldName && <div style={{ marginBottom: "2px" }}><strong>Conflicting field:</strong> {md.fieldName}</div>}
                              {md.suggestion && (
                                <div style={{ marginTop: "4px", color: "#0369a1", fontStyle: "italic" }}>
                                  💡 {md.suggestion}
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {alert.alertType === "deleted_invoice" && (
                          <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                            {(m.endClientName || alert.endClientName) && <div><strong>End client:</strong> {m.endClientName || alert.endClientName}</div>}
                            {(m.jobName || alert.jobName) && <div><strong>Job:</strong> {m.jobName || alert.jobName}{(m.projectCode || alert.projectCode) ? ` [${m.projectCode || alert.projectCode}]` : ""}</div>}
                            {(m.stableJobKey || alert.stableJobKey || m.invoiceRef || alert.invoiceRef) && <div><strong>Invoice ref:</strong> {m.stableJobKey || alert.stableJobKey || m.invoiceRef || alert.invoiceRef}</div>}
                            {(m.amount || alert.amount) && <div><strong>Amount:</strong> £{parseFloat(String(m.amount || alert.amount).replace(/[£,\s]/g, "")).toFixed(2)}</div>}
                            {(m.sentDate || alert.sentDate) && <div><strong>Sent date:</strong> {m.sentDate || alert.sentDate}</div>}
                            <div style={{ marginTop: "4px", color: "#c62828" }}>
                              Invoice reference appears in Confirmed jobs but was not found in the accounting system (it may have been deleted or voided in Xero).
                            </div>
                          </div>
                        )}

                        {alert.alertType === "deleted_expense" && (
                          <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                            {(m.endClientName || alert.endClientName) && <div><strong>End client:</strong> {m.endClientName || alert.endClientName}</div>}
                            {(m.jobName || alert.jobName) && <div><strong>Job:</strong> {m.jobName || alert.jobName}</div>}
                            {(m.stableJobKey || alert.stableJobKey) && <div><strong>Expense ID / Ref:</strong> {m.stableJobKey || alert.stableJobKey}</div>}
                            <div style={{ marginTop: "4px", color: "#c62828" }}>
                              Expense reference appears in Confirmed jobs but was not found in the accounting system (it may have been deleted or voided in Xero).
                            </div>
                          </div>
                        )}

                        {alert.alertType === "job_structure_error" && (
                          <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                            {(m.endClientName || alert.endClientName) && <div><strong>End client:</strong> {m.endClientName || alert.endClientName}</div>}
                            {(m.jobName || alert.jobName) && <div><strong>Job:</strong> {m.jobName || alert.jobName}{(m.projectCode || alert.projectCode) ? ` [${m.projectCode || alert.projectCode}]` : ""}</div>}
                            {alert.detail && (
                              <div style={{ marginTop: "4px", color: "#c62828" }}>
                                {stripRowInfo(alert.detail)}
                              </div>
                            )}
                          </div>
                        )}

                        {alert.alertType === "part_paid_balance" && (() => {
                          const isExp = (m.itemType || alert.itemType) === "expense";
                          const clientName = m.endClientName || alert.endClientName || alert.clientName;
                          const jName = m.jobName || alert.jobName || m.contractor || alert.contractor;
                          const confRow = m.confirmedRow || alert.confirmedRow;
                          const slot = m.slot || alert.slot;
                          const ref = m.ref || alert.ref || (isExp ? (m.appId || alert.appId) : "");
                          const balance = m.balanceAmount || alert.balanceAmount;
                          const sendDate = m.sendDate || alert.sendDate || m.recDate || alert.recDate;
                          const targetDate = m.targetDate || alert.targetDate;
                          const defaultIso = m.isoTargetDate || toInputDateFormat(targetDate);
                          const currentSelectedDate = partPaidDates[alert.alertKey] ?? defaultIso;
                          const isUpdating = !!updatingPartPaid[alert.alertKey];
                          const msg = partPaidMsg[alert.alertKey];

                          return (
                            <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "3px", marginTop: "2px", marginBottom: "4px" }}>
                              {clientName && <div><strong>{isExp ? "Contractor:" : "End client:"}</strong> {clientName}</div>}
                              {jName && !isExp && <div><strong>Job:</strong> {jName}</div>}
                              {ref && <div><strong>{isExp ? "Expense ID:" : "Invoice ref:"}</strong> {ref}</div>}
                              {balance && <div><strong>Unpaid balance:</strong> <span style={{ fontWeight: "600", color: "#0f172a" }}>£{parseFloat(balance).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>}
                              {sendDate && <div><strong>{isExp ? "Received date:" : "Sent date:"}</strong> {sendDate}</div>}

                              <div style={{
                                marginTop: "6px",
                                padding: "8px 10px",
                                backgroundColor: "#f5f3ff",
                                border: "1px solid #ddd6fe",
                                borderRadius: "6px",
                                color: "#5b21b6",
                                lineHeight: "1.4"
                              }}>
                                {alert.explanation || (
                                  <>
                                    Pulse is assuming this remaining balance will be {isExp ? "paid" : "collected"} on <strong>{targetDate}</strong> based on the {isExp ? "contractor monthly pay run rule (28th of the month, cutoff 20th)" : "overdue mid-month collection rule"}. You can select an alternative date below if agreed otherwise.
                                  </>
                                )}
                              </div>

                              <div style={{ marginTop: "8px", paddingTop: "8px", borderTop: "1px solid #e2e8f0" }}>
                                <label style={{ display: "block", fontSize: "11.5px", fontWeight: "600", color: "#374151", marginBottom: "4px" }}>
                                  Adjust expected payment date:
                                </label>
                                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                  <input
                                    type="date"
                                    value={currentSelectedDate}
                                    onChange={(e) => setPartPaidDates(prev => ({ ...prev, [alert.alertKey]: e.target.value }))}
                                    disabled={isUpdating}
                                    style={{
                                      padding: "5px 8px",
                                      borderRadius: "5px",
                                      border: "1px solid #cbd5e1",
                                      fontSize: "12px",
                                      color: "#1e293b",
                                      backgroundColor: "#fff"
                                    }}
                                  />
                                  <button
                                    className="triage-btn"
                                    onClick={() => handleSavePartPaidDate(alert)}
                                    disabled={isUpdating}
                                    style={{
                                      padding: "5px 12px",
                                      background: "#7c3aed",
                                      color: "#fff",
                                      border: "none",
                                      borderRadius: "5px",
                                      cursor: isUpdating ? "default" : "pointer",
                                      fontSize: "12px",
                                      fontWeight: "600",
                                      display: "flex",
                                      alignItems: "center",
                                      gap: "5px",
                                      opacity: isUpdating ? 0.7 : 1
                                    }}
                                  >
                                    {isUpdating ? <><Spinner size={12} /> Updating...</> : "Update date"}
                                  </button>
                                  {msg && (
                                    <span style={{ fontSize: "12px", fontWeight: "600", color: msg.startsWith("✓") ? "#16a34a" : "#dc2626" }}>
                                      {msg}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })()}

                        {!KNOWN_PROACTIVE_TYPES.has(alert.alertType) && (
                          <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                            {(m.endClientName || alert.endClientName) && <div><strong>End client:</strong> {m.endClientName || alert.endClientName}</div>}
                            {(m.jobName || alert.jobName) && <div><strong>Job:</strong> {m.jobName || alert.jobName}{(m.projectCode || alert.projectCode) ? ` [${m.projectCode || alert.projectCode}]` : ""}</div>}
                            {alert.detail && (
                              <div style={{ marginTop: "4px", color: "#444" }}>
                                {stripRowInfo(alert.detail)}
                              </div>
                            )}
                          </div>
                        )}

                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px", marginTop: "6px" }}>
                          <div style={{ fontSize: "11px", color: "#888" }}>
                            {alert.firstSeen ? `First seen: ${formatSeenTimestamp(alert.firstSeen)}` : ""}
                            {alert.firstSeen && alert.lastSeen ? " · " : ""}
                            {alert.lastSeen ? `Last seen: ${formatSeenTimestamp(alert.lastSeen)}` : ""}
                          </div>
                          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                            {(() => {
                              const cName = alert.clientName || selectedClient?.clientName;
                              const clientInfo = (clientsWithFlags || []).find(c => c.clientName === cName) || (allClientsMap && (allClientsMap[cName] || Object.values(allClientsMap).find(cl => cl.clientName?.toLowerCase() === cName?.toLowerCase()))) || selectedClient || { clientName: cName };
                              const jobTarget = getAlertJobTarget(alert, false, clientInfo);
                              return (
                                <>
                                  {jobTarget && onViewJob && (
                                    <button
                                      className="triage-btn"
                                      onClick={() => onViewJob(jobTarget)}
                                      style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#0284c7", borderColor: "#bae6fd" }}
                                      title={jobTarget.isOutgoings ? "View overhead expense details" : "View and edit job details in pop-up"}
                                    >
                                      {jobTarget.isOutgoings ? "🔍 View expense" : "🔍 View job"}
                                    </button>
                                  )}
                                  {alert.alertType === "deleted_invoice" && onDeleteInvoice && (
                                    <button
                                      className="triage-btn"
                                      onClick={() => {
                                        const rowNum = m.confirmedRow || alert.confirmedRow || (alert.detail && alert.detail.match(/row\s*(\d+)/i)?.[1]);
                                        const slotNum = m.slotNum || alert.slotNum || (alert.detail && alert.detail.match(/invoice slot\s*(\d+)/i)?.[1]);
                                        const invoiceRef = m.stableJobKey || alert.stableJobKey || m.invoiceRef || alert.invoiceRef || (alert.detail && alert.detail.match(/Invoice\s+([^\s(]+)/i)?.[1]);
                                        onDeleteInvoice({
                                          alert,
                                          clientInfo,
                                          clientName: cName,
                                          clientSheetId: clientInfo?.clientSheetId || alert.clientSheetId,
                                          masterSheetId: clientInfo?.masterSheetId || alert.masterSheetId,
                                          confirmedRow: rowNum ? Number(rowNum) : null,
                                          slotNum: slotNum ? Number(slotNum) : null,
                                          invoiceRef: invoiceRef ? String(invoiceRef).trim() : "",
                                          jobName: m.jobName || alert.jobName,
                                          endClientName: m.endClientName || alert.endClientName,
                                          projectCode: m.projectCode || alert.projectCode,
                                          amount: m.amount || alert.amount,
                                          sentDate: m.sentDate || alert.sentDate,
                                        });
                                      }}
                                      style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#dc2626", borderColor: "#fecaca" }}
                                      title="Delete this invoice entry from Pulse confirmed jobs"
                                    >
                                      Delete invoice from Pulse
                                    </button>
                                  )}
                                  {(alert.alertType === "contractorsDashboardDiscr" || alert.alertType === "expenseDashboardDiscr") && clientInfo && (
                                    <button className="triage-btn" onClick={() => onNavOutgoings ? onNavOutgoings(selectedClient || clientInfo) : setActiveNav("outgoings")} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#059669", borderColor: "#6ee7b7", whiteSpace: "nowrap" }}>Assign contractor costs</button>
                                  )}
                                  {alert.alertType === "passThroughDashboardDiscr" && clientInfo && (
                                    <button className="triage-btn" onClick={() => onNavPassThrough ? onNavPassThrough(selectedClient || clientInfo) : setActiveNav("passthrough")} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#059669", borderColor: "#6ee7b7", whiteSpace: "nowrap" }}>Assign pass-through costs</button>
                                  )}
                                  {alert.alertType === "invoiceDashboardDiscr" && clientInfo && (
                                    <button className="triage-btn" onClick={() => onNavInvoices ? onNavInvoices(selectedClient || clientInfo) : setActiveNav("invoices")} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#ea580c", borderColor: "#fdba74", whiteSpace: "nowrap" }}>Assign invoices</button>
                                  )}
                                </>
                              );
                            })()}
                            <button className="triage-btn" onClick={() => openCreateTaskModal(alert, true)} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#7c3aed", borderColor: "#c4b5fd", whiteSpace: "nowrap" }}>Create task</button>
                            <button
                              className="triage-btn no-click-spinner"
                              onClick={() => acknowledgeProactiveAlert(alert.alertKey, alert.rowIndex)}
                              disabled={isExiting}
                              style={{
                                ...styles.buttonSecondary,
                                fontSize: "12px",
                                padding: "4px 12px",
                                whiteSpace: "nowrap",
                                ...(isExiting ? { color: "#16a34a", borderColor: "#86efac", background: "#f0fdf4" } : {})
                              }}
                            >
                              {isExiting ? "Acknowledged" : "Acknowledge"}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* Full AutoLog entry modal */}
      {autoLogModalAlert && (
        <div style={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setAutoLogModalAlert(null); }}>
          <div style={{ ...styles.modalCard, maxWidth: "680px", width: "95%" }}>
            <h3 style={styles.modalTitle}>AutoLog entry: Retroactive P&L outgoings update</h3>
            <p style={{ ...styles.modalSubtitle, marginBottom: "8px" }}>
              <strong>Client:</strong> {autoLogModalAlert.clientName}
              {autoLogModalAlert.timestamp && <span style={{ marginLeft: "10px" }}>• <strong>Timestamp:</strong> {autoLogModalAlert.timestamp}</span>}
            </p>
            {autoLogModalAlert.heading && (
              <div style={{ fontSize: "12px", fontWeight: "600", color: "#374151", marginBottom: "8px" }}>
                {autoLogModalAlert.heading}
              </div>
            )}
            <div style={{
              fontFamily: "monospace",
              fontSize: "11px",
              color: "#1e293b",
              backgroundColor: "#f8fafc",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              padding: "10px 12px",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: "380px",
              overflowY: "auto"
            }}>
              {String(autoLogModalAlert.detail || autoLogModalAlert.detailsSnippet || autoLogModalAlert.metadata?.details || "")
                .split(/\r?\n/)
                .map(l => (l.match(/^\s*/)?.[0] || "") + sanitizeSpreadsheetTerms(l.trim()))
                .join("\n")
              }
            </div>
            <div style={{ ...styles.modalButtons, marginTop: "16px", display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button
                type="button"
                className="triage-btn"
                onClick={() => {
                  const txt = String(autoLogModalAlert.detail || autoLogModalAlert.detailsSnippet || autoLogModalAlert.metadata?.details || "");
                  navigator.clipboard.writeText(txt);
                  setCopiedAutoLog(true);
                  setTimeout(() => setCopiedAutoLog(false), 2000);
                }}
                style={styles.buttonSecondary}
              >
                {copiedAutoLog ? "Copied" : "Copy to clipboard"}
              </button>
              <button
                type="button"
                className="triage-btn"
                onClick={() => setAutoLogModalAlert(null)}
                style={{ ...styles.buttonSecondary, background: "#1f2937", color: "#fff", borderColor: "#1f2937" }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {totalVisibleAlertsCount === 0 && (
        <div style={{ textAlign: "center", padding: "40px 20px", color: "#666" }}>
          No alerts for this client
        </div>
      )}

      <style jsx>{`
        @media (max-width: 640px) {
          .non-admin-alert-card {
            padding: 12px 10px !important;
          }
        }
      `}</style>
    </div>
  );
}
