import React from "react";
import Spinner from "./Spinner";
import TruncatedCode from "./TruncatedCode";
import { stripRowInfo, parseUnreceivedExpensesDetail, parseStaleExpenseDetail, parseInfoAlertDetail, filterAnalysisResultsForAlert, getCleanPLCategoryName, getAlertJobTarget, formatSeenTimestamp } from "../utils/helpers";

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
]);

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
  onNavInvoices,
  onNavOutgoings,
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
  acknowledgingKey,
  freqLabel,
  totalVisibleAlertsCount,
  onViewJob,
  onDeleteInvoice
}) {
  const [selectedClassifications, setSelectedClassifications] = React.useState({});
  const [applyingClassification, setApplyingClassification] = React.useState({});
  const [classificationMsg, setClassificationMsg] = React.useState({});

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
    const classification = selectedClassifications[alertKey] || "delivery_expense";
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
          masterSheetId: targetMasterSheetId,
          clientSheetId: targetClientSheetId
        })
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to classify category");
      }
      setClassificationMsg(prev => ({ ...prev, [alertKey]: "✓ Applied and synced!" }));
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
                        {alerts.map((alert, idx) => (
                          <button
                            className="triage-btn"
                            key={idx}
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
                        ))}
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
                            📥 Assign invoices
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
                    ))}
                    {isExpenseGroup && selectedClient && (
                      <div style={{ display: "flex", justifyContent: "flex-start", marginTop: "4px" }}>
                        <button
                          className="triage-btn"
                          onClick={() => onNavOutgoings ? onNavOutgoings(selectedClient) : setActiveNav("outgoings")}
                          style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 14px", color: "#059669", borderColor: "#6ee7b7" }}
                        >
                          📤 Assign expenses
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
                          📥 Assign invoices
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
                const cardTitle = parsed?.tab === "Outgoings"
                  ? (parsed.contractor ? `Stale placeholder expense date moved (${parsed.contractor})` : "Stale placeholder expense date moved")
                  : (parsed?.client ? `${getFlagName(na.flagType) || na.flagName || "Alert"} (${parsed.client})` : (getFlagName(na.flagType) || na.flagName || "Alert"));

                return (
                  <div key={alertId} style={{
                    padding: "14px 16px",
                    borderRadius: "8px",
                    border: "1px solid #cbd5e1",
                    background: "#ffffff",
                    display: "flex",
                    flexDirection: "column",
                    gap: "4px",
                    boxSizing: "border-box",
                    width: "100%",
                  }}>
                    <div style={{
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
                      {parsed.tab && <div><strong>Tab:</strong> {parsed.tab}{parsed.slot ? ` (Slot ${parsed.slot})` : ""}</div>}
                      {parsed.month && <div><strong>Month:</strong> {parsed.month}</div>}
                      {parsed.client && <div><strong>End client:</strong> {parsed.client}</div>}
                      {parsed.contractor && <div><strong>{parsed.tab === "Outgoings" ? "Vendor:" : "Contractor:"}</strong> {parsed.contractor}</div>}
                      {parsed.job && <div><strong>Job:</strong> {parsed.job}{parsed.projectCode ? ` [${parsed.projectCode}]` : ""}</div>}
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
                      {parsed.highlight && (
                        <div style={{ marginTop: "4px", fontWeight: "600", color: "#0284c7" }}>
                          {parsed.highlight}
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
                              className="triage-btn"
                              onClick={() => onViewJob(jobTarget)}
                              style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#0284c7", borderColor: "#bae6fd" }}
                              title={jobTarget.isOutgoings ? "View Outgoings expense details" : "View and edit job details in pop-up"}
                            >
                              {jobTarget.isOutgoings ? "🔍 View expense" : "🔍 View job"}
                            </button>
                          );
                        })()}
                        <button className="triage-btn"
                          onClick={() => openCreateTaskModal(na, false, true)}
                          style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#7c3aed", borderColor: "#c4b5fd" }}
                        >
                          📋 Create Task
                        </button>
                        <button className="triage-btn"
                          onClick={() => handleMarkNoActionResolved(na)}
                          style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px" }}
                        >
                          ✓ Mark resolved
                        </button>
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
                return (
                  <div key={idx} style={{ border: "1px solid #cbd5e1", borderRadius: "8px", padding: "14px 16px", backgroundColor: "#ffffff", boxSizing: "border-box", width: "100%", display: "flex", flexDirection: "column", gap: "4px" }}>
                    <div style={{ fontWeight: "600", fontSize: "13.5px", color: "#0f172a", marginBottom: "2px" }}>
                      {alert.heading}
                    </div>

                    {alert.alertType === "retainer_invoice" && (
                      <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                        {m.endClientName && <div><strong>End client:</strong> {m.endClientName}</div>}
                        {m.jobName && <div><strong>Job:</strong> {m.jobName}</div>}
                        {m.revenue && <div><strong>Monthly revenue:</strong> {m.revenue}</div>}
                        {m.startDate && <div><strong>Contract period:</strong> {m.startDate} → {m.endDate}</div>}
                        {m.frequencyDays && <div><strong>Invoice frequency:</strong> {freqLabel(m.frequencyDays)} (every ~{m.frequencyDays} days)</div>}
                        {m.lastInvoiceDate && <div><strong>Last invoice sent:</strong> {m.lastInvoiceDate}</div>}
                        {m.expectedByDate && <div><strong>Next expected by:</strong> {m.expectedByDate}</div>}
                        {m.possibleMatchInvoiceNo && (
                          <div style={{ marginTop: "6px", paddingTop: "6px", borderTop: "1px solid #e2e8f0" }}>
                            {m.possibleMatchCase === "changed" && (
                              <div style={{ display: "inline-block", padding: "1px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "600", marginBottom: "4px", background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca" }}>
                                Possible retainer change - {m.possibleMatchConfidence === "high" ? "high" : "medium"} confidence
                              </div>
                            )}
                            {m.possibleMatchCase === "draft" && (
                              <div style={{ display: "inline-block", padding: "1px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "600", marginBottom: "4px", background: "#f0f9ff", color: "#0369a1", border: "1px solid #bae6fd" }}>
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
                          <div style={{ marginTop: "8px", paddingTop: "8px", borderTop: "1px solid #e2e8f0", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                            {m.possibleMatchInvoiceNo ? (
                              <>
                                <button className="triage-btn" onClick={() => {
                                  const clientInfo = getClientInfoForAlert(alert);
                                  const targetClientSheetId = clientInfo?.clientSheetId || selectedClient?.clientSheetId || m.clientSheetId;
                                  const targetMasterSheetId = clientInfo?.masterSheetId || selectedClient?.masterSheetId || m.masterSheetId;
                                  const targetClientName = alert.clientName || selectedClient?.clientName || "";
                                  setRetainerAlertResolution({
                                    resolutionType: "changeAmount",
                                    alertMeta: { ...m, clientName: targetClientName },
                                    alertKey: alert.alertKey,
                                    clientSheetId: targetClientSheetId,
                                    masterSheetId: targetMasterSheetId
                                  });
                                }} style={{ padding: "6px 12px", background: "#1976d2", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>Change retainer amount</button>
                                <button className="triage-btn" onClick={() => {
                                  const clientInfo = getClientInfoForAlert(alert);
                                  const targetClientSheetId = clientInfo?.clientSheetId || selectedClient?.clientSheetId || m.clientSheetId;
                                  const targetMasterSheetId = clientInfo?.masterSheetId || selectedClient?.masterSheetId || m.masterSheetId;
                                  const targetClientName = alert.clientName || selectedClient?.clientName || "";
                                  setRetainerSplitInvoice({
                                    alertMeta: { ...m, clientName: targetClientName },
                                    alertKey: alert.alertKey,
                                    clientSheetId: targetClientSheetId,
                                    masterSheetId: targetMasterSheetId
                                  });
                                }} style={{ padding: "6px 12px", background: "#0284c7", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>Split invoice</button>
                              </>
                            ) : (
                              <button className="triage-btn" onClick={() => {
                                const clientInfo = getClientInfoForAlert(alert);
                                const targetClientSheetId = clientInfo?.clientSheetId || selectedClient?.clientSheetId || m.clientSheetId;
                                const targetMasterSheetId = clientInfo?.masterSheetId || selectedClient?.masterSheetId || m.masterSheetId;
                                const targetClientName = alert.clientName || selectedClient?.clientName || "";
                                setRetainerAlertResolution({
                                  resolutionType: "end",
                                  alertMeta: { ...m, clientName: targetClientName },
                                  alertKey: alert.alertKey,
                                  clientSheetId: targetClientSheetId,
                                  masterSheetId: targetMasterSheetId
                                });
                              }} style={{ padding: "6px 12px", background: "#dc2626", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>End retainer</button>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {alert.alertType === "uninvoiced_new_job" && (
                      <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                        {m.endClientName && <div><strong>End client:</strong> {m.endClientName}</div>}
                        {m.jobName && <div><strong>Job:</strong> {m.jobName}{m.projectCode ? ` [${m.projectCode}]` : ""}</div>}
                        {m.startDate && <div><strong>Job started:</strong> {m.startDate}</div>}
                        {m.revenue && <div><strong>Revenue:</strong> £{parseFloat(m.revenue).toFixed(2)}</div>}
                        <div style={{ marginTop: "4px", color: "#c62828" }}>Over a month elapsed with zero real invoices sent.</div>
                      </div>
                    )}

                    {alert.alertType === "uninvoiced_revenue" && (
                      <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                        {m.endClientName && <div><strong>End client:</strong> {m.endClientName}</div>}
                        {m.jobName && <div><strong>Job:</strong> {m.jobName}{m.projectCode ? ` [${m.projectCode}]` : ""}</div>}
                        {m.endDate && <div><strong>Job ended:</strong> {m.endDate}</div>}
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
                          {eDate && <div><strong>Job ended:</strong> {eDate}</div>}
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
                          <div><strong>Location:</strong> Outgoings tab{month ? ` (${month})` : ""}{cellCoord ? `, Cell ${cellCoord}` : ""}</div>
                          {appId && <div><strong>App ID:</strong> {appId}</div>}
                          {amount && <div><strong>Amount:</strong> £{parseFloat(amount).toFixed(2)}</div>}
                          {recDate && <div><strong>Received date:</strong> {recDate} {weeksAgo ? <span style={{ color: "#b45309", fontWeight: "600" }}>({weeksAgo} weeks ago - overdue)</span> : null}</div>}
                          {payDate && <div><strong>Estimated pay date:</strong> {payDate}</div>}
                          {desc && <div style={{ marginTop: "2px", color: "#78716c", fontStyle: "italic" }}>{desc}</div>}
                        </div>
                      );
                    })()}

                    {alert.alertType === "retroactive_outgoings_update" && (
                      <div style={{ fontSize: "12px", color: "#555", marginTop: "2px", marginBottom: "4px", whiteSpace: "pre-line", lineHeight: "1.4" }}>
                        {alert.detail || alert.detailsSnippet || m.details}
                      </div>
                    )}

                    {alert.alertType === "unmapped_pl_category" && (() => {
                      const catName = alert.metadata?.categoryName || alert.metadata?.cleanName || alert.heading;
                      const currentChoice = selectedClassifications[alert.alertKey] || "delivery_expense";
                      const isApplying = !!applyingClassification[alert.alertKey];
                      const msg = classificationMsg[alert.alertKey];

                      const OPTIONS = [
                        { value: "delivery_expense", label: "Delivery expense (Other costs of sale)" },
                        { value: "non_delivery_expense", label: "Non-delivery expense (Overheads)" },
                        { value: "revenue", label: "Revenue" },
                        { value: "cos_staff", label: "CoS staff cost" },
                        { value: "non_cos_staff", label: "Non-CoS staff cost" },
                        { value: "contractor", label: "Track as a Contractor" },
                        { value: "corporation_tax", label: "Corporation tax" },
                        { value: "depreciation", label: "Depreciation" },
                        { value: "non_operating_income", label: "Non-operating income" },
                        { value: "non_operating_expense", label: "Non-operating expense" },
                        { value: "ignore", label: "Ignore entirely" }
                      ];

                      return (
                        <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "4px", marginTop: "2px", marginBottom: "4px" }}>
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
                                minWidth: "260px",
                                cursor: "pointer"
                              }}
                            >
                              {OPTIONS.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>

                            <button
                              className="triage-btn"
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
                                opacity: isApplying ? 0.7 : 1
                              }}
                            >
                              {isApplying ? <><Spinner size={12} /> Confirming &amp; Syncing...</> : "Confirm & Apply"}
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

                    {alert.alertType === "revenue_mismatch" && (
                      <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                        {(() => {
                          const detail = stripRowInfo(alert.detail || "");
                          const mismatchIdx = detail.indexOf("Mismatched entries:");
                          const effectiveIdx = mismatchIdx !== -1 ? mismatchIdx : detail.indexOf("Mismatched rows:");
                          const label = mismatchIdx !== -1 ? "Mismatched entries:" : "Mismatched rows:";
                          if (effectiveIdx === -1) return <div style={{ fontWeight: "600" }}>{detail}</div>;
                          const header = detail.slice(0, effectiveIdx).trim();
                          const rowsPart = detail.slice(effectiveIdx + label.length).trim();
                          const rows = rowsPart.split(";").map(s => s.trim()).filter(Boolean);
                          return (
                            <>
                              <div style={{ fontWeight: "600", marginBottom: "4px" }}>{header}</div>
                              <div style={{ fontWeight: "600", marginBottom: "2px" }}>Mismatched entries:</div>
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
                      <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                        {alert.metadata?.tab && <span style={{ display: "inline-block", marginBottom: "4px", padding: "2px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "600", background: "#f0f9ff", color: "#0369a1", border: "1px solid #bae6fd", width: "fit-content" }}>{alert.metadata.tab} tab</span>}
                        {(() => {
                          const detail = stripRowInfo(alert.detail || "");
                          const mismatchIdx = detail.indexOf("Mismatched entries:");
                          const effectiveIdx = mismatchIdx !== -1 ? mismatchIdx : detail.indexOf("Mismatched rows:");
                          const label = mismatchIdx !== -1 ? "Mismatched entries:" : "Mismatched rows:";
                          if (effectiveIdx === -1) return <div style={{ fontWeight: "600" }}>{detail}</div>;
                          const header = detail.slice(0, effectiveIdx).trim();
                          const rowsPart = detail.slice(effectiveIdx + label.length).trim();
                          const rows = rowsPart.split(";").map(s => s.trim()).filter(Boolean);
                          return (
                            <>
                              <div style={{ fontWeight: "600", marginBottom: "4px" }}>{header}</div>
                              <div style={{ fontWeight: "600", marginBottom: "2px" }}>Mismatched entries:</div>
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

                    {alert.alertType === "pipeline_confirmed_overlap" && (() => {
                      const md = alert.metadata || {};
                      return (
                        <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                          <div style={{ fontWeight: "600", color: "#c62828", marginBottom: "4px" }}>Job exists in both tabs but Pipeline is not closed out</div>
                          <div style={{ marginBottom: "2px" }}><strong>Confirmed tab</strong></div>
                          {md.endClientName && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Client: {md.endClientName}</div>}
                          {md.jobName && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Job: {md.jobName}</div>}
                          {md.projectCode && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Project code: {md.projectCode}</div>}
                          {md.jobType && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Job type: {md.jobType}</div>}
                          <div style={{ marginBottom: "2px", marginTop: "4px" }}><strong>Pipeline tab</strong></div>
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
                          <div style={{ fontWeight: "600", color: "#c62828", marginBottom: "4px" }}>Retainer contract shrunk - excess child row could not be removed automatically</div>
                          {md.clientJobStr && <div style={{ marginBottom: "2px" }}><strong>Job:</strong> {md.clientJobStr}</div>}
                          {md.childRowNum && <div style={{ marginBottom: "2px" }}><strong>Blocked child row:</strong> {md.childRowNum}</div>}
                          {md.timestamp && <div style={{ marginBottom: "4px" }}><strong>First detected:</strong> {String(md.timestamp).slice(0, 10)}</div>}
                          <div style={{ color: "#0369a1", fontStyle: "italic" }}>Row {md.childRowNum} falls outside the new contract period but contains actuals (invoices or expenses) so cannot be auto-removed. Manual review required.</div>
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
                          Invoice reference appears on Confirmed tab but was not found in the accounting system (it may have been deleted or voided in Xero).
                        </div>
                      </div>
                    )}

                    {alert.alertType === "deleted_expense" && (
                      <div style={{ fontSize: "12px", color: "#555", display: "flex", flexDirection: "column", gap: "2px", marginTop: "2px", marginBottom: "4px" }}>
                        {(m.endClientName || alert.endClientName) && <div><strong>End client:</strong> {m.endClientName || alert.endClientName}</div>}
                        {(m.jobName || alert.jobName) && <div><strong>Job:</strong> {m.jobName || alert.jobName}</div>}
                        {(m.stableJobKey || alert.stableJobKey) && <div><strong>Expense ID / Ref:</strong> {m.stableJobKey || alert.stableJobKey}</div>}
                        <div style={{ marginTop: "4px", color: "#c62828" }}>
                          Expense reference appears on Confirmed tab but was not found in the accounting system (it may have been deleted or voided in Xero).
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
                                  title={jobTarget.isOutgoings ? "View Outgoings expense details" : "View and edit job details in pop-up"}
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
                                  title="Delete this invoice entry from the Confirmed tab in Pulse"
                                >
                                  Delete invoice from Pulse
                                </button>
                              )}
                              {alert.alertType === "expenseDashboardDiscr" && clientInfo && (
                                <button className="triage-btn" onClick={() => onNavOutgoings ? onNavOutgoings(selectedClient || clientInfo) : setActiveNav("outgoings")} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#059669", borderColor: "#6ee7b7" }}>📤 Assign Expense</button>
                              )}
                              {alert.alertType === "invoiceDashboardDiscr" && clientInfo && (
                                <button className="triage-btn" onClick={() => onNavInvoices ? onNavInvoices(selectedClient || clientInfo) : setActiveNav("invoices")} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#ea580c", borderColor: "#fdba74" }}>📥 Assign Invoices</button>
                              )}
                            </>
                          );
                        })()}
                        <button className="triage-btn" onClick={() => openCreateTaskModal(alert, true)} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#7c3aed", borderColor: "#c4b5fd" }}>📋 Create Task</button>
                        <button
                          className="triage-btn"
                          onClick={() => acknowledgeProactiveAlert(alert.alertKey, alert.rowIndex)}
                          disabled={acknowledgingKey === (alert.alertKey || (alert.rowIndex != null ? `row-${alert.rowIndex}` : null))}
                          style={{
                            ...styles.buttonSecondary,
                            fontSize: "12px",
                            padding: "4px 12px",
                            opacity: acknowledgingKey === (alert.alertKey || (alert.rowIndex != null ? `row-${alert.rowIndex}` : null)) ? 0.7 : 1
                          }}
                        >
                          {acknowledgingKey === (alert.alertKey || (alert.rowIndex != null ? `row-${alert.rowIndex}` : null)) ? (
                            <><Spinner size={11} /> Acknowledging...</>
                          ) : (
                            "✓ Acknowledge"
                          )}
                        </button>
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
