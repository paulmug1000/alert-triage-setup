import React, { useState } from "react";
import Spinner from "./Spinner";
import TruncatedCode from "./TruncatedCode";
import { useTriage } from "../contexts/TriageContext";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { useTasks } from "../contexts/TaskContext";
import { stripRowInfo, cleanUserFacingText, formatSeenTimestamp } from "../utils/helpers";
import JobMatchCard, { buildJobsFromRows } from "./JobMatchCard";
import ExploreJobsModal from "./ExploreJobsModal";
import OutgoingsContractorPickerModal from "./OutgoingsContractorPickerModal";
import JobDetailModal from "./JobDetailModal";
import InvoicesNewJobModal from "./InvoicesNewJobModal";

export default function TriageAnalysisView({
  styles, setScreen, getFlagName, setActiveNav, handleNavTasks,
  isAdmin: propIsAdmin, user
}) {
  const isAdmin = propIsAdmin !== undefined
    ? propIsAdmin
    : !!(user?.isAdmin || user?.role === "Admin");
  const { openCreateTaskModal } = useTasks();
  const {
    selectedClient, clientAlerts, currentClientAlertIndex, setCurrentClientAlertIndex,
    acceptError, setAcceptError, clientsWithFlags, setClientsWithFlags, fromCache, setFromCache,
    selectAlert, setClientAlerts, claudeAnalysis, setClaudeAnalysis,
    previousIgnoreReason, setPreviousIgnoreReason, acceptOption, isAccepting,
    isAnalyzing, setIsAnalyzing, existingTaskBanner, setExistingTaskBanner,
    showIgnoreModal, setShowIgnoreModal, ignoreReason, setIgnoreReason,
    isIgnoring, ignoreAlert, sessionId, processedAlerts, setProcessedAlerts,
    allNoActionResolved, resolvedNoActionFlags, handlePostClear
  } = useTriage();

  const { allClientsMap, automationCommanderSheetId } = useAppGlobals();

  // Modals & Placement State
  const [exploreJobsOpen, setExploreJobsOpen] = useState(false);
  const [outgoingsPickerOpen, setOutgoingsPickerOpen] = useState(false);
  const [createNewJobOpen, setCreateNewJobOpen] = useState(false);
  const [placementPrompt, setPlacementPrompt] = useState(null);
  const [confirmJobModal, setConfirmJobModal] = useState(null);
  const [viewingJobTarget, setViewingJobTarget] = useState(null);
  const [isSavingPlacement, setIsSavingPlacement] = useState(false);

  let clientInfo = (clientsWithFlags || []).find(c => c.clientName === selectedClient?.clientName);
  if (!clientInfo?.clientSheetId && !clientInfo?.masterSheetId) {
    clientInfo = allClientsMap[selectedClient?.clientName] || selectedClient || {};
  }
  const targetClientSheetId = clientInfo?.clientSheetId || clientInfo?.sheetId || selectedClient?.clientSheetId || "";

  const alert = clientAlerts[currentClientAlertIndex];
  const alertFlags = alert?.data?.flags || [];
  const isExpenseType = alert?.type === "expense" || alert?.flagType === "expenseDashboardDiscr" || alert?.sheetName === "DirComp";
  const isInvoiceType = alert?.type === "invoice" || alert?.flagType === "invoiceDashboardDiscr" || alert?.sheetName === "InvComp";
  const isCrmType = alert?.type === "crm" || alert?.sheetName === "CRMComp" || Boolean(alert?.alertType?.startsWith("crm")) || Boolean(alert?.flagType?.startsWith("crm"));

  const handleResolveAlertAfterPlacement = async (targetAlert, description) => {
    const alertId = `${targetAlert.sheetName}-${targetAlert.rowNumber}`;
    const uniqueId = targetAlert.fingerprintHash || `${targetAlert.flagType || targetAlert.type}-${targetAlert.sheetName}-${targetAlert.rowNumber}`;

    setProcessedAlerts(new Set([...processedAlerts, uniqueId]));

    if (sessionId) {
      fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove_alert", sessionId, alertId }),
      }).catch(() => { });
    }

    if (automationCommanderSheetId) {
      fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "record_decision",
          alert: targetAlert,
          decision: {
            action: "ACCEPTED",
            notes: description || "Placed from alert triage"
          },
          automationCommanderSheetId
        })
      }).catch(() => { });
    }

    const updatedAlerts = clientAlerts.filter((_, idx) => idx !== currentClientAlertIndex);
    setClientAlerts(updatedAlerts);

    let acceptedFlagType = targetAlert.flagType || targetAlert.alertType || targetAlert.type || "";
    if (acceptedFlagType === "invoice") acceptedFlagType = "invoiceDashboardDiscr";
    if (acceptedFlagType === "expense") acceptedFlagType = "expenseDashboardDiscr";
    if (acceptedFlagType === "crm") acceptedFlagType = "crmPipeAppDiscr";

    setClientsWithFlags(prev => prev.map(c => {
      if (c.clientName !== selectedClient?.clientName) return c;
      const updatedCounts = { ...(c.alertCounts || {}) };
      const updatedFlags = { ...(c.flags || {}) };
      if (updatedCounts[acceptedFlagType] > 0) updatedCounts[acceptedFlagType]--;
      if ((updatedCounts[acceptedFlagType] || 0) === 0) updatedFlags[acceptedFlagType] = false;
      return { ...c, alertCounts: updatedCounts, flags: updatedFlags };
    }));

    if (updatedAlerts.length === 0) {
      if (allNoActionResolved()) {
        handlePostClear([], resolvedNoActionFlags);
      } else {
        setScreen("alertSelection");
        setCurrentClientAlertIndex(0);
      }
    } else {
      setScreen("alertSelection");
      setCurrentClientAlertIndex(0);
    }
  };

  const handleInitiatePlaceOnJob = (jobArg, maybeSlotNum, maybeSlot, maybeRowNum, createNewRow = false, customLabel = null) => {
    let jobRow = jobArg;
    let slotNum = maybeSlotNum;
    let slot = maybeSlot;
    if (jobArg && typeof jobArg === "object" && jobArg.slotNum !== undefined && maybeSlotNum === undefined) {
      slotNum = jobArg.slotNum;
      slot = jobArg.slot;
      jobRow = {
        client: jobArg.jobClient || jobArg.client,
        jobName: jobArg.jobName,
        projectCode: jobArg.projectCode,
        rowNum: jobArg.rowNum,
        tabName: jobArg.tabName || "Confirmed"
      };
    }
    const targetRowNum = maybeRowNum || jobRow.rowNum || jobRow.rows?.[0]?.rowNum;

    const isRetainer = String(jobRow.projectRetainer || jobRow.jobType || "").toLowerCase().includes("retainer");
    const slotLabel = customLabel || (createNewRow
      ? (isExpenseType ? "New Direct Cost" : "New Invoice Entry")
      : (isExpenseType
          ? `Direct Cost ${slotNum || 1}`
          : (isRetainer ? `Month ${slotNum || 1} Invoice` : `Invoice ${slotNum || 1}`)
        ));

    if (isExpenseType) {
      const amt = parseFloat(String(alert.summary?.amount || alert.data?.accounting?.[2] || "0").replace(/[£$€,\s]/g, "")) || 0;
      const desc = alert.summary?.description || alert.summary?.reference || alert.data?.accounting?.[1] || "Expense";
      const date = alert.summary?.date || alert.data?.accounting?.[0] || "";
      const vat = (alert.summary?.vatAmount && parseFloat(String(alert.summary.vatAmount).replace(/,/g, "")) > 0) ? "Yes" : (alert.data?.accounting?.[8] ? "Yes" : "No");
      const txnId = alert.summary?.transactionId || alert.data?.accounting?.[11] || "";
      const status = alert.summary?.status || alert.data?.accounting?.[5] || "Received";

      setPlacementPrompt({
        type: "expense_job",
        jobClient: jobRow.client || selectedClient?.clientName,
        jobName: jobRow.jobName,
        projectCode: jobRow.projectCode || "",
        rowNum: targetRowNum,
        slotNum,
        slot,
        slotLabel,
        isRetainer,
        createNewRow: Boolean(createNewRow),
        tabName: "Confirmed",
        amount: amt,
        description: desc,
        date,
        vat,
        transactionId: txnId,
        status,
        daysToPay: 30
      });
    } else {
      const invNo = alert.summary?.invoiceNo || alert.data?.accounting?.[5] || "";
      const amt = parseFloat(String(alert.summary?.amount || alert.data?.accounting?.[2] || "0").replace(/[£$€,\s]/g, "")) || 0;
      const sentDate = alert.summary?.sentDate || alert.data?.accounting?.[6] || "";
      const status = alert.summary?.status || alert.data?.accounting?.[9] || "Sent";

      setPlacementPrompt({
        type: "invoice",
        jobClient: jobRow.client || selectedClient?.clientName,
        jobName: jobRow.jobName,
        projectCode: jobRow.projectCode || "",
        rowNum: targetRowNum,
        slotNum,
        slot,
        slotLabel,
        isRetainer,
        createNewRow: Boolean(createNewRow),
        tabName: "Confirmed",
        invoiceNo: invNo,
        amount: amt,
        sentDate,
        status,
        daysToPay: 30
      });
    }
  };

  const handleInitiatePlaceOnContractor = ({ contractor, month, colLetter, sheetRow, cell }) => {
    const amt = parseFloat(String(alert.summary?.amount || alert.data?.accounting?.[2] || "0").replace(/[£$€,\s]/g, "")) || 0;
    const desc = alert.summary?.description || alert.summary?.reference || alert.data?.accounting?.[1] || "Expense";
    const date = alert.summary?.date || alert.data?.accounting?.[0] || "";
    const status = alert.summary?.status || alert.data?.accounting?.[5] || "Received";

    setPlacementPrompt({
      type: "expense_contractor",
      contractorName: contractor.name,
      sheetRow,
      colLetter,
      monthLabel: month.label,
      cell,
      amount: amt,
      description: desc,
      date,
      status
    });
  };

  const executeConfirmedPlacement = async () => {
    if (!placementPrompt || !targetClientSheetId) return;
    setIsSavingPlacement(true);
    setAcceptError("");

    try {
      if (placementPrompt.type === "invoice") {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update_invoice_slot",
            clientSheetId: targetClientSheetId,
            clientName: selectedClient?.clientName || "",
            tabName: placementPrompt.tabName || "Confirmed",
            rowNum: placementPrompt.rowNum,
            slotNum: placementPrompt.slotNum,
            createNewRow: Boolean(placementPrompt.createNewRow),
            jobClient: placementPrompt.jobClient,
            jobName: placementPrompt.jobName,
            invoice: {
              invoiceNo: placementPrompt.invoiceNo,
              amount: parseFloat(placementPrompt.amount) || 0,
              sentDate: placementPrompt.sentDate || "",
              daysToPay: parseInt(placementPrompt.daysToPay, 10) || 30,
              status: placementPrompt.status || "Sent"
            }
          })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Failed to place invoice");

        setPlacementPrompt(null);
        setExploreJobsOpen(false);
        const invDesc = placementPrompt.createNewRow
          ? `Added new invoice entry for invoice #${placementPrompt.invoiceNo} on ${placementPrompt.jobName}`
          : `Placed invoice #${placementPrompt.invoiceNo} on ${placementPrompt.jobName} (${placementPrompt.slotLabel || "Invoice"})`;
        await handleResolveAlertAfterPlacement(alert, invDesc);
      } else if (placementPrompt.type === "expense_job") {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update_expense_slot",
            clientSheetId: targetClientSheetId,
            clientName: selectedClient?.clientName || "",
            tabName: placementPrompt.tabName || "Confirmed",
            rowNum: placementPrompt.rowNum,
            slotNum: placementPrompt.slotNum,
            createNewRow: Boolean(placementPrompt.createNewRow),
            jobClient: placementPrompt.jobClient,
            jobName: placementPrompt.jobName,
            expense: {
              description: placementPrompt.description,
              amount: parseFloat(placementPrompt.amount) || 0,
              vat: placementPrompt.vat || "No",
              date: placementPrompt.date || "",
              daysToPay: parseInt(placementPrompt.daysToPay, 10) || 30,
              status: placementPrompt.status || "Received",
              transactionId: placementPrompt.transactionId || ""
            }
          })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Failed to place expense on job");

        setPlacementPrompt(null);
        setExploreJobsOpen(false);
        const expDesc = placementPrompt.createNewRow
          ? `Added new direct cost entry for expense on ${placementPrompt.jobName}`
          : `Placed expense of £${placementPrompt.amount} on ${placementPrompt.jobName} (${placementPrompt.slotLabel || "Direct Cost"})`;
        await handleResolveAlertAfterPlacement(alert, expDesc);
      } else if (placementPrompt.type === "expense_contractor") {
        const newBlock = {
          appId: alert.summary?.appId || alert.data?.accounting?.[11] || `EXP-${Date.now()}`,
          amount: parseFloat(placementPrompt.amount) || 0,
          status: placementPrompt.status || "Received",
          recDate: placementPrompt.date || "",
          payDate: placementPrompt.payDate || "",
          description: placementPrompt.description || ""
        };
        const existingBlocks = placementPrompt.cell?.blocks || [];
        const updatedBlocks = [...existingBlocks, newBlock];

        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update_outgoing_note",
            clientSheetId: targetClientSheetId,
            clientName: selectedClient?.clientName || "",
            contractorName: placementPrompt.contractorName,
            sheetRow: placementPrompt.sheetRow,
            colLetter: placementPrompt.colLetter,
            blocks: updatedBlocks,
            automationCommanderSheetId
          })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Failed to update contractor note in Outgoings");

        setPlacementPrompt(null);
        setOutgoingsPickerOpen(false);
        await handleResolveAlertAfterPlacement(alert, `Placed expense of £${placementPrompt.amount} on contractor ${placementPrompt.contractorName} (${placementPrompt.monthLabel})`);
      }
    } catch (err) {
      setAcceptError(`Error placing item: ${err.message}`);
    } finally {
      setIsSavingPlacement(false);
    }
  };

  const executeConfirmedJobCreation = async () => {
    if (!confirmJobModal || !targetClientSheetId) return;
    setIsSavingPlacement(true);
    setAcceptError("");

    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_new_job",
          clientSheetId: targetClientSheetId,
          clientName: selectedClient?.clientName || "",
          tabName: confirmJobModal.tabName || "Confirmed",
          jobData: {
            client: confirmJobModal.client.trim(),
            jobName: confirmJobModal.jobName.trim(),
            projectCode: confirmJobModal.projectCode.trim(),
            projectRetainer: confirmJobModal.projectRetainer || "Project",
            status: confirmJobModal.tabName || "Confirmed",
            likelihood: confirmJobModal.likelihood || "100",
            revenue: parseFloat(String(confirmJobModal.revenue || "0").replace(/[£$€,\s]/g, "")) || 0,
            directCosts: parseFloat(String(confirmJobModal.directCosts || "0").replace(/[£$€,\s]/g, "")) || 0,
            vat: confirmJobModal.vat || "Yes",
            dateConfirmed: new Date().toISOString().split("T")[0],
            startDate: confirmJobModal.startDate || "",
            endDate: confirmJobModal.endDate || "",
            invoices: [],
            expenses: []
          }
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to create job in Pulse");

      setConfirmJobModal(null);
      await handleResolveAlertAfterPlacement(alert, `Created new job "${confirmJobModal.jobName}" in Pulse from CRM`);
    } catch (err) {
      setAcceptError(`Error creating job: ${err.message}`);
    } finally {
      setIsSavingPlacement(false);
    }
  };
  const progress = currentClientAlertIndex + 1;
  const isMissingFlag = String(alertFlags[0] || "").trim() === "1";
  const isMissingCost = isExpenseType && isMissingFlag;
  const isMissingInvoice = isInvoiceType && isMissingFlag;
  const isCrmMismatch = isCrmType && (alert?.subType === "field_mismatch" || (!isMissingFlag && alertFlags.length > 0));

  const otherDuplicateAlerts = (isInvoiceType && alert?.summary?.invoiceNo)
    ? clientAlerts.filter(a => {
      const thisId = alert.fingerprintHash || `${alert.sheetName}-${alert.rowNumber}`;
      const otherId = a.fingerprintHash || `${a.sheetName}-${a.rowNumber}`;
      if (thisId === otherId) return false;
      const otherInvNo = String(a.summary?.invoiceNo || a.data?.accounting?.[5] || "").trim();
      return otherInvNo && otherInvNo.toLowerCase() === String(alert.summary.invoiceNo).trim().toLowerCase();
    })
    : [];

  const isDuplicateInvoice = isInvoiceType && Boolean(
    alert?.isDuplicateInvoice ||
    (alert?.sheetName === "InvComp" && String(alert?.data?.flags?.[4] || "").trim() === "1") ||
    (alert?.spreadsheetItems && alert.spreadsheetItems.length > 1) ||
    otherDuplicateAlerts.length > 0
  );
  const spreadsheetItems = isInvoiceType ? (alert?.spreadsheetItems || []) : [];

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>Alerts</h1>
        <p style={styles.subtitle}>{selectedClient?.clientName} - Alert {progress} of {clientAlerts.length}</p>
      </div>

      <div style={styles.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <button className="triage-btn" onClick={() => { setAcceptError(""); setCurrentClientAlertIndex(0); setScreen("alertSelection"); }} style={{ ...styles.buttonSecondary, fontSize: "13px" }}>
            ← Back to Alerts
          </button>
          {(() => {
            let info = (clientsWithFlags || []).find(c => c.clientName === selectedClient.clientName);

            if (!info?.clientSheetId && !info?.masterSheetId) {
              info = allClientsMap[selectedClient.clientName] || selectedClient;
            }

            if (!isAdmin || (!info?.clientSheetId && !info?.masterSheetId)) return null;
            return (
              <button className="triage-btn" onClick={() => {
                if (info.clientSheetId) window.open(`https://docs.google.com/spreadsheets/d/${info.clientSheetId}/edit`, "_blank");
                if (info.masterSheetId) window.open(`https://docs.google.com/spreadsheets/d/${info.masterSheetId}/edit`, "_blank");
              }} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px", color: "#1d4ed8", borderColor: "#93c5fd" }}>
                📊 Open Sheets
              </button>
            );
          })()}
        </div>
        <div style={styles.alertHeader}>
          <h2 style={styles.alertTitle}>
            {alert.clientName || alert.type || "Financial Alert"}
            {fromCache && (
              <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={styles.cacheBadge}>⚡ Cached</span>
                <button className="triage-btn" onClick={async () => {
                  try {
                    const bustRes = await fetch("/api/triage", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        action: "bust_cache",
                        fingerprintHash: alert.fingerprintHash || undefined,
                        rowNumber: alert.rowNumber,
                        sheetName: alert.sheetName,
                        automationCommanderSheetId,
                      }),
                    });
                    const bustData = await bustRes.json();
                    if (!bustData.success) {
                      console.error("Cache bust failed:", bustData.error);
                      return;
                    }
                    setFromCache(false);

                    // CRITICAL FIX: Delete the old options from local React memory so selectAlert is forced to fetch fresh data
                    const freshAlert = { ...clientAlerts[currentClientAlertIndex] };
                    delete freshAlert.options;

                    setClientAlerts(prev => {
                      const newAlerts = [...prev];
                      newAlerts[currentClientAlertIndex] = freshAlert;
                      return newAlerts;
                    });

                    // Small delay to ensure Sheets write has committed before re-fetching
                    await new Promise(r => setTimeout(r, 1000));
                    await selectAlert(freshAlert);
                  } catch (e) { console.error("Cache bust failed:", e); }
                }} style={{ fontSize: "11px", padding: "2px 8px", background: "#f0f0f0", border: "1px solid #ccc", borderRadius: "4px", cursor: "pointer", color: "#555" }}>
                  ↻ Refresh
                </button>
              </span>
            )}
          </h2>
          <span style={styles.alertCounter}>{progress}/{clientAlerts.length}</span>
        </div>

        {(alert.flagType || alert.alertType || alert.type) && (() => {
          const key = alert.flagType || alert.alertType || alert.type;
          const fullName = getFlagName(key);
          return (
            <div style={{ ...styles.alertMetadata, fontSize: "15px", fontWeight: "600", padding: "14px", marginBottom: "16px", color: "#1d4ed8", backgroundColor: "#eff6ff", borderLeft: "4px solid #3b82f6" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>{fullName}</span>
                {(alert.firstSeen || alert.lastSeen) && (
                  <span style={{ fontSize: "11px", color: "#3b82f6", fontWeight: "500", opacity: 0.8 }}>
                    {alert.firstSeen ? `First seen: ${formatSeenTimestamp(alert.firstSeen)}` : ""}
                    {alert.firstSeen && alert.lastSeen ? " · " : ""}
                    {alert.lastSeen ? `Last seen: ${formatSeenTimestamp(alert.lastSeen)}` : ""}
                  </span>
                )}
              </div>
            </div>
          );
        })()}

        {alert.type === "locked" && alert.summary?.lockedMessage && (
          <div style={{ ...styles.alertSummary, marginBottom: "20px", backgroundColor: "#fff3e0", borderLeft: "4px solid #f59e0b" }}>
            <h3 style={{ fontSize: "13px", fontWeight: "700", marginBottom: "8px", color: "#92400e", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              🔒 Automation In Progress
            </h3>
            <div style={{ fontSize: "13px", lineHeight: "1.6", color: "#78350f" }}>
              {alert.summary.lockedMessage}
            </div>
          </div>
        )}

        {(isInvoiceType || isExpenseType) && alert.summary && alert.type !== "locked" && (
          <div style={{
            ...styles.alertSummary, marginBottom: "20px",
            backgroundColor: alert.type === "expense" ? "#f0fdf4" : "#eff6ff",
            borderLeft: `4px solid ${alert.type === "expense" ? "#16a34a" : "#2563eb"}`
          }}>
            <h3 style={{ fontSize: "17px", fontWeight: "700", marginBottom: "8px", color: alert.type === "expense" ? "#166534" : "#1e40af" }}>
              ⚠ {alert.type === "expense" ? (() => {
                const expFlags = alert.data?.flags || [];
                const isMissing = String(expFlags[0] || "").trim() === "1";
                if (isMissing) return "Missing expense in accounting system, not in Pulse";
                const expFlagNames = [null, "Duplicate app ID", "Description mismatch", "Amount mismatch", "VAT mismatch", "Received date mismatch", "Pay date mismatch", "Status mismatch"];
                const active = expFlags.map((v, i) => String(v || "").trim() === "1" && expFlagNames[i] ? expFlagNames[i] : null).filter(Boolean);
                return active.length > 0 ? `Field mismatch: ${active.join(", ").toLowerCase()}` : "Expense discrepancy";
              })()
                : (() => {
                  const flags = alert.data?.flags || [];
                  const isMissing = String(flags[0] || "").trim() === "1";
                  if (isMissing) return "Missing invoice in accounting system, not in Pulse";
                  const invFlagNames2 = [null, "Client mismatch", "Amount mismatch", "Sent date mismatch", "Duplicate invoice in sheet", "Pay date mismatch", "Status mismatch"];
                  const active = flags.map((v, i) => String(v || "").trim() === "1" && invFlagNames2[i] ? invFlagNames2[i] : null).filter(Boolean);
                  return active.length > 0 ? `Field mismatch: ${active.join(", ").toLowerCase()}` : "Invoice discrepancy";
                })()
              }
            </h3>
            <div style={{ fontSize: "13px", lineHeight: "1.6", color: "#333" }}>
              {alert.type === "expense" ? (
                // Expense display
                <>
                  {alert.summary.reference && <div><strong>Reference:</strong> {alert.summary.reference}</div>}
                  {alert.summary.description && <div><strong>Description:</strong> {alert.summary.description}</div>}
                  <div><strong>Amount:</strong> £{alert.summary.amount.toFixed(2)}{(() => {
                    const vat = parseFloat(String(alert.summary.vatAmount || "0").replace(/[£$€,\s]/g, "")) || 0;
                    return vat > 0 ? " +VAT" : " (no VAT)";
                  })()}</div>
                  {alert.summary.date && <div><strong>Date:</strong> {alert.summary.date}</div>}
                  {alert.summary.accountName && <div><strong>Account name:</strong> {alert.summary.accountName}</div>}
                  {alert.summary.status && <div><strong>Status:</strong> {alert.summary.status}</div>}
                  {alert.summary.transactionId && <div><strong>Transaction ID:</strong> {alert.summary.transactionId}</div>}
                </>
              ) : (
                // Invoice display
                <>
                  <div><strong>Invoice:</strong> {alert.summary.invoiceNo}</div>
                  <div><strong>Amount:</strong> £{alert.summary.amount.toFixed(2)}{alert.summary.vatIncluded && alert.summary.vatIncluded > 0 ? " +VAT" : " (no VAT)"}</div>
                  <div><strong>Client:</strong> {alert.summary.client}</div>
                  {alert.summary.job && <div><strong>Description:</strong> {alert.summary.job}</div>}
                  {alert.summary.sentDate && <div><strong>Sent:</strong> {alert.summary.sentDate}</div>}
                  {alert.summary.status && <div><strong>Status:</strong> {alert.summary.status}</div>}
                </>
              )}
            </div>
            {/* Field-by-field comparison lines for mismatched fields only */}
            {(() => {
              const flags = alert.data?.flags || [];
              const isMissing = String(flags[0] || "").trim() === "1";
              if (isMissing) return null;
              const acc = alert.data?.accounting || [];
              const conf = alert.data?.confirmed || [];
              let mismatchLines = [];
              if (alert.type === "expense") {
                const expFlagNames = ["Missing cost", "Duplicate app ID", "Description mismatch", "Amount mismatch", "VAT mismatch", "Rec date mismatch", "Pay date mismatch", "Status mismatch"];
                const activeFlags = flags.map((v, i) => String(v || "").trim() === "1" && expFlagNames[i] ? expFlagNames[i] : null).filter(Boolean);
                const FIELD_DEFS = [
                  { name: "Description mismatch", line: `Description in accounting: ${acc[1] || "(blank)"}. Description in Confirmed tab: ${conf[3] || "(blank)"}.` },
                  { name: "Amount mismatch", line: `Amount in accounting: ${acc[2] ? `£${acc[2]}` : "£0"}. Amount in Confirmed tab: ${conf[4] ? `£${conf[4]}` : "£0"}.` },
                  { name: "VAT mismatch", line: `VAT in accounting: ${acc[8] ? `£${acc[8]}` : "£0"}. VAT in Confirmed tab: ${conf[6] || "(blank)"}.` },
                  { name: "Rec date mismatch", line: `Received date in accounting: ${acc[0] || "(blank)"}. Received date in Confirmed tab: ${conf[7] || "(blank)"}.` },
                  { name: "Pay date mismatch", line: `Pay date in accounting: ${acc[7] || "(blank)"}. Pay date in Confirmed tab: ${conf[8] || "(blank)"}.` },
                  { name: "Status mismatch", line: `Status in accounting: ${acc[5] || "(blank)"}. Status in Confirmed tab: ${conf[9] || "(blank)"}.` },
                ];
                mismatchLines = FIELD_DEFS.filter(f => activeFlags.includes(f.name));
              } else {
                const invFlagNames = ["Missing invoice", "Client mismatch", "Amount mismatch", "Sent date mismatch", "Duplicate invoice in sheet", "Pay date mismatch", "Status mismatch"];
                const activeFlags = flags.map((v, i) => String(v || "").trim() === "1" && invFlagNames[i] ? invFlagNames[i] : null).filter(Boolean);
                const FIELD_DEFS = [
                  { name: "Client mismatch", line: `Client in accounting: ${acc[0] || "(blank)"}. Client in Confirmed tab: ${conf[1] || "(blank)"}.` },
                  { name: "Amount mismatch", line: `Amount in accounting: ${acc[2] ? `£${acc[2]}` : "£0"}. Amount in Confirmed tab: ${conf[2] ? `£${conf[2]}` : "£0"}.` },
                  { name: "Sent date mismatch", line: `Sent date in accounting: ${acc[6] || "(blank)"}. Sent date in Confirmed tab: ${conf[3] || "(blank)"}.` },
                  { name: "Duplicate invoice in sheet", line: `Duplicate invoice number: Invoice #${alert.summary?.invoiceNo || acc[5] || conf[0]} appears in multiple rows in the spreadsheet (${spreadsheetItems.length > 0 ? spreadsheetItems.length : 2} entries).` },
                  { name: "Pay date mismatch", line: `Pay date in accounting: ${acc[8] || "(blank)"}. Pay date in Confirmed tab: ${conf[4] || "(blank)"}.` },
                  { name: "Status mismatch", line: `Status in accounting: ${acc[9] || "(blank)"}. Status in Confirmed tab: ${conf[5] || "(blank)"}.` },
                ];
                mismatchLines = FIELD_DEFS.filter(f => activeFlags.includes(f.name));
              }
              if (mismatchLines.length === 0) return null;
              return (
                <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px", color: "#333", marginTop: "10px", paddingTop: "10px", borderTop: "1px solid rgba(0,0,0,0.08)" }}>
                  {mismatchLines.map(f => <div key={f.name}>{f.line}</div>)}
                </div>
              );
            })()}
          </div>
        )}

        {isDuplicateInvoice && (
          <div style={{
            backgroundColor: "#fffbeb", border: "1.5px solid #f59e0b",
            borderRadius: "6px", padding: "14px 16px", marginBottom: "16px",
            color: "#92400e"
          }}>
            <div style={{ fontWeight: "700", fontSize: "14px", display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span>⚠️ Duplicate Invoice in Spreadsheet Notice</span>
              <span style={{ background: "#d97706", color: "white", padding: "2px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "700" }}>
                {spreadsheetItems.length > 0 ? `${spreadsheetItems.length} SPREADSHEET ITEMS` : "DUPLICATE INVOICE NO"}
              </span>
              {alert.summary?.invoiceNo && <span style={{ fontSize: "13px", color: "#78350f" }}>Invoice #{alert.summary.invoiceNo}</span>}
            </div>
            <div style={{ fontSize: "13px", marginTop: "6px", lineHeight: "1.5" }}>
              {spreadsheetItems.length > 0 ? (
                <>This invoice number appears in <strong>{spreadsheetItems.length} distinct items/jobs in the spreadsheet</strong>, but only <strong>once in accounting</strong>{isAdmin ? ` (InvComp Row ${alert.rowNumber})` : ""}.</>
              ) : otherDuplicateAlerts.length > 0 ? (
                <>Invoice <strong>#{alert.summary?.invoiceNo}</strong> also appears in <strong>{otherDuplicateAlerts.length}</strong> other entry/entries in this triage batch{isAdmin ? ` (InvComp Row${otherDuplicateAlerts.length > 1 ? "s" : ""}: ${otherDuplicateAlerts.map(a => a.rowNumber).join(", ")})` : ""}.</>
              ) : (
                <>{isAdmin ? `This invoice number is flagged as having multiple entries in the spreadsheet (InvComp Column W, Row ${alert.rowNumber}).` : "This invoice number is flagged as having multiple entries in the spreadsheet."}</>
              )}
            </div>

            {/* Spreadsheet Line Items Table */}
            {spreadsheetItems.length > 0 && (
              <div style={{ marginTop: "12px", background: "white", border: "1px solid #fcd34d", borderRadius: "6px", overflow: "hidden" }}>
                <div style={{ background: "#fef3c7", padding: "6px 10px", fontWeight: "700", fontSize: "12px", color: "#92400e", borderBottom: "1px solid #fde68a" }}>
                  📊 Spreadsheet Breakdown ({spreadsheetItems.length} items for Invoice #{alert.summary?.invoiceNo})
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse", textAlign: "left" }}>
                    <thead>
                      <tr style={{ background: "#fffdf5", borderBottom: "1px solid #fde68a", fontSize: "11px", color: "#78350f" }}>
                        <th style={{ padding: "6px 8px" }}>Spreadsheet Job / Item</th>
                        <th style={{ padding: "6px 8px", textAlign: "right" }}>Excl VAT</th>
                        <th style={{ padding: "6px 8px", textAlign: "right" }}>VAT</th>
                        <th style={{ padding: "6px 8px", textAlign: "right" }}>Gross</th>
                        <th style={{ padding: "6px 8px" }}>Sent</th>
                        <th style={{ padding: "6px 8px" }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {spreadsheetItems.map((item, idx) => (
                        <tr key={idx} style={{ borderBottom: "1px solid #fef3c7" }}>
                          <td style={{ padding: "6px 8px", fontWeight: "600", color: "#111827" }}>
                            {item.job || "(No job name)"}
                            {item.client && <div style={{ fontSize: "10px", color: "#6b7280", fontWeight: "normal" }}>{item.client}</div>}
                          </td>
                          <td style={{ padding: "6px 8px", textAlign: "right" }}>£{item.netAmount.toFixed(2)}</td>
                          <td style={{ padding: "6px 8px", textAlign: "right" }}>£{item.vatAmount.toFixed(2)}</td>
                          <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: "600" }}>£{item.grossAmount.toFixed(2)}</td>
                          <td style={{ padding: "6px 8px", color: "#4b5563" }}>{item.sentDate || "-"}</td>
                          <td style={{ padding: "6px 8px" }}>
                            <span style={{ fontSize: "10px", padding: "1px 5px", borderRadius: "3px", background: "#f3f4f6", color: "#374151" }}>
                              {item.status || "-"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: "#fff7ed", fontWeight: "700", borderTop: "1.5px solid #fed7aa", color: "#9a3412" }}>
                        <td style={{ padding: "6px 8px" }}>Spreadsheet Total ({spreadsheetItems.length} items):</td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>
                          £{spreadsheetItems.reduce((s, it) => s + it.netAmount, 0).toFixed(2)}
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>
                          £{spreadsheetItems.reduce((s, it) => s + it.vatAmount, 0).toFixed(2)}
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>
                          £{spreadsheetItems.reduce((s, it) => s + it.grossAmount, 0).toFixed(2)}
                        </td>
                        <td colSpan={2}></td>
                      </tr>
                      <tr style={{ background: "#eff6ff", fontWeight: "700", borderTop: "1px solid #bfdbfe", color: "#1e40af" }}>
                        <td style={{ padding: "6px 8px" }}>Accounting Total{isAdmin ? ` (Row ${alert.rowNumber})` : ""}:</td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>
                          £{(parseFloat(String(alert.data?.accounting?.[3] || "0").replace(/,/g, "")) || alert.summary?.amount || 0).toFixed(2)}
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>
                          £{(parseFloat(String(alert.data?.accounting?.[4] || "0").replace(/,/g, "")) || 0).toFixed(2)}
                        </td>
                        <td style={{ padding: "6px 8px", textAlign: "right" }}>
                          £{(parseFloat(String(alert.data?.accounting?.[2] || "0").replace(/,/g, "")) || 0).toFixed(2)}
                        </td>
                        <td colSpan={2}></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            <div style={{ fontSize: "12px", marginTop: "8px", color: "#b45309" }}>
              Review all spreadsheet entries against accounting before resolving this discrepancy.
            </div>
          </div>
        )}

        {acceptError && (
          <div style={{ ...styles.errorBanner, marginBottom: "16px" }}>
            {acceptError}
            {acceptError.includes("go back to the alert list") && (
              <div style={{ marginTop: "10px" }}>
                <button className="triage-btn"
                  onClick={() => { setAcceptError(""); setCurrentClientAlertIndex(0); setScreen("alertSelection"); }}
                  style={{ ...styles.buttonSecondary, fontSize: "13px" }}>
                  ← Back to Alert List
                </button>
              </div>
            )}
          </div>
        )}

        {claudeAnalysis && (
          <div>
            {previousIgnoreReason && (
              <div style={{ marginBottom: "12px", padding: "10px 14px", backgroundColor: "#fff8e1", borderLeft: "4px solid #f59e0b", borderRadius: "4px", fontSize: "13px", color: "#78350f" }}>
                <div><strong>⚠ Previously ignored:</strong> {previousIgnoreReason.ignoreReason}</div>
                {previousIgnoreReason.changeReason && (
                  <div style={{ marginTop: "6px", color: "#92400e", fontStyle: "italic" }}>
                    <strong>Resurfaced because:</strong> {previousIgnoreReason.changeReason}
                  </div>
                )}
              </div>
            )}
            {/* Discrepancy summary - what this alert actually is, and the specific field(s) at issue */}
            {(() => {
              const ft = alert?.flagType || alert?.alertType || alert?.type || "";
              const isCRM = ft.startsWith("crm");
              if (!isCRM) return null;
              const isPipeline = ft.includes("Pipe");
              const isMismatch = alert.subType === "field_mismatch";
              const tabLabel = isPipeline ? "Pipeline" : "Confirmed";
              const isDash = ft.includes("Dash");
              const sd = alert.data?.sheetData || [];
              const cd = alert.data?.crmData || [];

              // Helpers for formatting
              const formatCurrency = (val) => {
                if (val === null || val === undefined || String(val).trim() === "") return "£0";
                const clean = String(val).replace(/[£$€,\s]/g, "");
                const num = parseFloat(clean);
                if (isNaN(num)) return String(val);
                return "£" + num.toLocaleString("en-GB", { minimumFractionDigits: Number.isInteger(num) ? 0 : 2, maximumFractionDigits: 2 });
              };

              const formatLikelihood = (val) => {
                if (val === null || val === undefined || String(val).trim() === "") return "-";
                const s = String(val).trim();
                if (s.endsWith("%")) return s;
                const num = parseFloat(s);
                if (isNaN(num)) return s;
                const pct = num <= 1 ? Math.round(num * 100) : Math.round(num);
                return `${pct}%`;
              };

              // Safely pull job type from options if available
              let optionJobType = "";
              try {
                const parsed = JSON.parse(claudeAnalysis);
                if (Array.isArray(parsed)) {
                  const withType = parsed.find(o => o.jobRowsData?.[0]?.projectRetainer || o.newJobData?.projectRetainer || o.matchingDetails?.unmatchedJobSummary?.projectRetainer);
                  if (withType?.jobRowsData?.[0]?.projectRetainer) optionJobType = withType.jobRowsData[0].projectRetainer;
                  else if (withType?.newJobData?.projectRetainer) optionJobType = withType.newJobData.projectRetainer;
                }
              } catch (e) { }

              // Column mapping:
              // Dash discrepancy:
              //   CRM (X:AJ):   [0]=client, [1]=job, [2]=code, [3]=revenue, [4]=dirCosts, [5]=start, [6]=end, [7]=likelihood, [8]=status, [9]=type
              //   Sheet (AO:AW): [0]=code, [1]=client, [2]=job, [3]=revenue, [4]=dirCosts, [5]=start, [6]=end, [7]=likelihood, [8]=type
              // App discrepancy:
              //   Sheet (EF:ER): [0]=client, [1]=job, [2]=code, [3]=revenue, [4]=dirCosts, [5]=start, [6]=end, [7]=likelihood
              //   CRM (EU:FD):   [0]=code, [1]=client, [2]=job, [3]=revenue, [4]=dirCosts, [5]=start, [6]=end, [7]=likelihood, [8]=status, [9]=type

              const crmClient = isDash ? cd[0] : cd[1];
              const crmJob = isDash ? cd[1] : cd[2];
              const crmCode = isDash ? cd[2] : cd[0];
              const crmRev = cd[3];
              const crmCosts = cd[4];
              const crmStart = cd[5];
              const crmEnd = cd[6];
              const crmLikely = cd[7];
              const crmType = cd[9];

              const shtClient = isDash ? sd[1] : sd[0];
              const shtJob = isDash ? sd[2] : sd[1];
              const shtCode = isDash ? sd[0] : sd[2];
              const shtRev = sd[3];
              const shtCosts = sd[4];
              const shtStart = sd[5];
              const shtEnd = sd[6];
              const shtLikely = sd[7];
              const shtType = (isDash ? sd[8] : optionJobType) || cd[9] || optionJobType || "";

              const pickVal = (v1, v2) => (v1 !== null && v1 !== undefined && String(v1).trim() !== "") ? v1 : v2;

              // Top title values
              const displayClient = (isDash ? (crmClient || shtClient) : (shtClient || crmClient)) || "";
              const displayJob = (isDash ? (crmJob || shtJob) : (shtJob || crmJob)) || "";
              const displayCode = (isDash ? (crmCode || shtCode) : (shtCode || crmCode)) || "";

              // Full details values (for missing job or summary grid)
              const displayRev = isDash ? pickVal(crmRev, shtRev) : pickVal(shtRev, crmRev);
              const displayCosts = isDash ? pickVal(crmCosts, shtCosts) : pickVal(shtCosts, crmCosts);
              const displayStart = isDash ? pickVal(crmStart, shtStart) : pickVal(shtStart, crmStart);
              const displayEnd = isDash ? pickVal(crmEnd, shtEnd) : pickVal(shtEnd, crmEnd);
              const displayLikely = isDash ? pickVal(crmLikely, shtLikely) : pickVal(shtLikely, crmLikely);
              const displayType = isDash ? pickVal(crmType, shtType) : pickVal(shtType, crmType);

              // Field mismatch definitions
              const FIELD_DEFS = [
                { name: "Client name", crm: crmClient, sheet: shtClient, fmt: v => v || "(blank)" },
                { name: "Job name", crm: crmJob, sheet: shtJob, fmt: v => v || "(blank)" },
                { name: "Revenue", crm: crmRev, sheet: shtRev, fmt: formatCurrency },
                { name: "Direct costs", crm: crmCosts, sheet: shtCosts, fmt: formatCurrency },
                { name: "Start date", crm: crmStart, sheet: shtStart, fmt: v => v || "(blank)" },
                { name: "End date", crm: crmEnd, sheet: shtEnd, fmt: v => v || "(blank)" },
                { name: "% Likelihood", crm: crmLikely, sheet: shtLikely, fmt: formatLikelihood },
              ];
              const mismatchedFieldNames = alert.mismatchFields || [];
              const mismatchedFields = FIELD_DEFS.filter(f => mismatchedFieldNames.includes(f.name));

              const subHeader = isMismatch
                ? `Field mismatch: ${mismatchedFieldNames.join(", ")}`
                : isDash
                  ? `Missing job - in CRM, not in Pulse ${tabLabel.toLowerCase()} jobs`
                  : `Missing job - in Pulse ${tabLabel.toLowerCase()} jobs, not in CRM`;

              return (
                <div style={{ marginBottom: "16px", padding: "14px 16px", backgroundColor: "#f5f3ff", borderLeft: "4px solid #7c3aed", borderRadius: "4px" }}>
                  <div style={{ fontSize: "17px", fontWeight: "700", color: "#5b21b6", marginBottom: "8px" }}>
                    ⚠ {subHeader}
                  </div>
                  <div style={{ fontSize: "15px", fontWeight: "600", color: "#1a1a1a", marginBottom: "12px" }}>
                    {displayClient}{displayJob ? ` - ${displayJob}` : ""}{displayCode ? ` (${displayCode})` : ""}
                  </div>

                  {/* Full Job Details Grid */}
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: "8px 16px",
                    backgroundColor: "rgba(255, 255, 255, 0.75)",
                    border: "1px solid #e9d5ff",
                    borderRadius: "6px",
                    padding: "10px 14px",
                    fontSize: "13px",
                    color: "#374151"
                  }}>
                    <div>
                      <span style={{ color: "#6b7280", fontWeight: "500" }}>Revenue: </span>
                      <strong style={{ color: "#111827" }}>{formatCurrency(displayRev)}</strong>
                    </div>
                    <div>
                      <span style={{ color: "#6b7280", fontWeight: "500" }}>Direct costs: </span>
                      <strong style={{ color: "#111827" }}>{formatCurrency(displayCosts)}</strong>
                    </div>
                    <div>
                      <span style={{ color: "#6b7280", fontWeight: "500" }}>Retainer / Project: </span>
                      <strong style={{ color: "#111827" }}>{displayType || "Project"}</strong>
                    </div>
                    <div>
                      <span style={{ color: "#6b7280", fontWeight: "500" }}>Start date: </span>
                      <strong style={{ color: "#111827" }}>{displayStart || "(blank)"}</strong>
                    </div>
                    <div>
                      <span style={{ color: "#6b7280", fontWeight: "500" }}>End date: </span>
                      <strong style={{ color: "#111827" }}>{displayEnd || "(blank)"}</strong>
                    </div>
                    {isPipeline && (
                      <div>
                        <span style={{ color: "#6b7280", fontWeight: "500" }}>Likelihood: </span>
                        <strong style={{ color: "#111827" }}>{formatLikelihood(displayLikely)}</strong>
                      </div>
                    )}
                  </div>

                  {/* Field Mismatch Callout */}
                  {isMismatch && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px", fontSize: "13px", color: "#374151", marginTop: "12px", paddingTop: "12px", borderTop: "1px solid #e9d5ff" }}>
                      <div style={{ fontWeight: "600", color: "#6d28d9", marginBottom: "2px" }}>Mismatched fields:</div>
                      {mismatchedFields.map(f => (
                        <div key={f.name} style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                          <span style={{ color: "#b45309", fontWeight: "600" }}>⚠ {f.name}:</span>
                          <span>CRM: <strong>{f.fmt(f.crm)}</strong></span>
                          <span style={{ color: "#9ca3af" }}>•</span>
                          <span>Pulse {tabLabel.toLowerCase()} jobs: <strong>{f.fmt(f.sheet)}</strong></span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* For CRM Missing Job in Pulse: Clear 2-Action Cards */}
                  {!isMismatch && isDash && (
                    <div style={{ marginTop: "16px", paddingTop: "14px", borderTop: "1px solid #e9d5ff" }}>
                      <div style={{ fontSize: "14px", fontWeight: "700", color: "#5b21b6", marginBottom: "10px" }}>
                        Possible actions
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "12px" }}>
                        {/* Option 1: Create Job in Pulse */}
                        <div style={{ background: "#ffffff", border: "1.5px solid #7c3aed", borderRadius: "8px", padding: "14px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                          <div>
                            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                              <span style={{ fontSize: "16px" }}>➕</span>
                              <strong style={{ color: "#6d28d9", fontSize: "14px" }}>Create Job in Pulse</strong>
                            </div>
                            <p style={{ fontSize: "12px", color: "#4b5563", margin: "4px 0 12px 0", lineHeight: "1.4" }}>
                              Add this CRM deal to your <strong>{tabLabel}</strong> jobs in Pulse with the pre-filled revenue, dates, and client information.
                            </p>
                          </div>
                          <button
                            type="button"
                            className="triage-btn"
                            onClick={() => {
                              setConfirmJobModal({
                                client: displayClient,
                                jobName: displayJob,
                                projectCode: displayCode || "",
                                projectRetainer: displayType || "Project",
                                tabName: tabLabel,
                                likelihood: isPipeline ? (displayLikely || "50") : "100",
                                revenue: displayRev || 0,
                                directCosts: displayCosts || 0,
                                vat: "Yes",
                                startDate: displayStart || "",
                                endDate: displayEnd || ""
                              });
                            }}
                            style={{
                              ...styles.decisionButton,
                              ...styles.approveButton,
                              width: "100%",
                              padding: "9px 14px",
                              fontSize: "13px",
                              fontWeight: "600",
                              background: "#7c3aed",
                              borderColor: "#6d28d9",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              gap: "6px"
                            }}
                          >
                            ➕ Create Job in Pulse
                          </button>
                        </div>

                        {/* Option 2: Ignore Deal */}
                        <div style={{ background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "8px", padding: "14px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                          <div>
                            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                              <span style={{ fontSize: "16px" }}>🚫</span>
                              <strong style={{ color: "#475569", fontSize: "14px" }}>Ignore Deal</strong>
                            </div>
                            <p style={{ fontSize: "12px", color: "#64748b", margin: "4px 0 12px 0", lineHeight: "1.4" }}>
                              Dismiss this alert if this deal should not be created or tracked in Pulse (e.g. test, duplicate, or cancelled).
                            </p>
                          </div>
                          <button
                            type="button"
                            className="triage-btn"
                            onClick={() => setShowIgnoreModal(true)}
                            style={{
                              ...styles.buttonSecondary,
                              width: "100%",
                              padding: "9px 14px",
                              fontSize: "13px",
                              fontWeight: "600",
                              color: "#64748b",
                              borderColor: "#cbd5e1",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              gap: "6px"
                            }}
                          >
                            🚫 Ignore Deal
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* For CRM Missing Jobs (non-mismatch), actions are already rendered inside the CRM card above */}
            {(!((alert?.flagType || alert?.alertType || alert?.type || "").startsWith("crm")) || alert.subType === "field_mismatch" || !((alert?.flagType || alert?.alertType || alert?.type || "").includes("Dash"))) && (
              <>
                <h3 style={{ fontSize: "14px", fontWeight: "700", marginBottom: "12px", color: "#1e293b" }}>
                  Possible actions
                </h3>
                {(() => {
                  try {
                    const options = JSON.parse(claudeAnalysis);
                    if (Array.isArray(options)) {
                      const getOptionJobDetails = (opt, alertObj) => {
                        const m = opt?.matchingDetails?.matchedJobDetails || {};
                        const u = opt?.matchingDetails?.unmatchedJobSummary || {};
                        const j = opt?.jobDetails || {};
                        return {
                          client: j.client || j.clientName || m.clientName || m.client || alertObj?.summary?.client || alertObj?.clientName || "",
                          clientName: j.clientName || j.client || m.clientName || m.client || alertObj?.summary?.client || alertObj?.clientName || "",
                          jobName: j.jobName || j.job || m.jobName || m.job || alertObj?.summary?.jobName || "",
                          job: j.jobName || j.job || m.jobName || m.job || alertObj?.summary?.jobName || "",
                          projectCode: j.projectCode || m.projectCode || "",
                          revenue: (j.revenue && j.revenue !== "0") ? j.revenue : (m.revenue || opt?.slotBreakdown?.correctedTotal || alertObj?.summary?.amount || ""),
                          directCosts: (j.directCosts && j.directCosts !== "0") ? j.directCosts : (m.directCosts || "£0"),
                          projectRetainer: j.projectRetainer || j.type || m.projectRetainer || m.type || "",
                          type: j.projectRetainer || j.type || m.projectRetainer || m.type || "",
                          startDate: j.startDate || m.startDate || "",
                          endDate: j.endDate || m.endDate || "",
                          tabName: j.tabName || m.tabName || "Confirmed",
                          rowNum: j.rowNum || opt?.jobRow || 1,
                          vatSetting: j.vatSetting || j.vat || m.vat || "Yes"
                        };
                      };

                      // Data mismatch alerts (amount mismatch, date mismatch, duplicate invoice, CRM field mismatch)
                      // must NOT be rendered as slot-placement candidate cards (JobMatchCard).
                      // They should be rendered directly as Action Cards.
                      const isDataMismatch = ((isInvoiceType || isExpenseType) && !isMissingFlag) || isCrmMismatch;

                      // Check if there are candidate job match options (only for unplaced / missing items, NEVER for CRM or data mismatches)
                      const candidateJobOptions = (isDataMismatch || isCrmType)
                        ? []
                        : options.filter(opt =>
                            (Array.isArray(opt.jobRowsData) && opt.jobRowsData.length > 0) ||
                            opt.jobDetails ||
                            opt.matchType === "existing_job" ||
                            opt.matchType === "job_match"
                          );

                      // Suppress generic AI fallback option only when candidate job match cards actually exist
                      const otherOptions = options.filter(opt => {
                        if (candidateJobOptions.includes(opt)) return false;
                        if (candidateJobOptions.length > 0) {
                          const title = String(opt.title || "").toLowerCase();
                          const reason = String(opt.matchAnalysis?.reasonForChoice || "").toLowerCase();
                          if (title.includes("manual investigation") || title.includes("no confident automatic match") || reason.includes("manual investigation required")) {
                            return false;
                          }
                        }
                        return true;
                      });

                      return (
                        <div>
                          {/* 1. Candidate Job Match Cards (CRM Style - Missing items only) */}
                          {candidateJobOptions.map((option, idx) => {
                            const conf = option.matchAnalysis?.matchConfidence || (idx === 0 ? "High confidence" : null);
                            const reason = option.businessLogic || option.matchAnalysis?.reasonForChoice || (typeof option.matchAnalysis === 'string' ? option.matchAnalysis : null);
                            const fbDetails = getOptionJobDetails(option, alert);
                            const rawJobs = option.jobRowsData ? buildJobsFromRows(option.jobRowsData, fbDetails) : null;
                            const candidateJob = rawJobs?.[0] || null;

                            return (
                              <JobMatchCard
                                key={`candidate-job-${idx}`}
                                candidateIndex={idx}
                                job={candidateJob}
                                jobDetails={fbDetails}
                                mode={isExpenseType ? "expense" : "invoice"}
                                isAdmin={isAdmin}
                                confidence={conf}
                                recommendationReason={reason}
                                alertSummary={alert.summary}
                                onPlaceSlot={(job, slotNum, slot, rowNum, createNewRow, customLabel) => handleInitiatePlaceOnJob(job, slotNum, slot, rowNum, createNewRow, customLabel)}
                                onViewJob={(job) => {
                                  setViewingJobTarget({
                                    clientSheetId: targetClientSheetId,
                                    clientName: job.client || selectedClient?.clientName,
                                    jobName: job.jobName,
                                    rowNum: job.rows?.[0]?.rowNum || job.rowNum,
                                    tabName: job.tabName || "Confirmed"
                                  });
                                }}
                              />
                            );
                          })}

                          {/* 2. Generic / Info Options or Data Mismatch Action Cards */}
                          {otherOptions.map((option, idx) => {
                            const isDeleteAction = option.matchType === "delete";
                            const isIgnoreAction = option.matchType === "ignore";
                            return (
                              <div
                                key={`other-opt-${idx}`}
                                style={{
                                  ...styles.optionCard,
                                  marginBottom: "16px",
                                  ...(isDeleteAction ? { borderColor: "#fca5a5", borderLeft: "4px solid #ef4444" } : {}),
                                  ...(isIgnoreAction ? { borderColor: "#cbd5e1", borderLeft: "4px solid #94a3b8", backgroundColor: "#f8fafc" } : {})
                                }}
                              >
                                <div style={{
                                  ...styles.optionTitle,
                                  color: isDeleteAction ? "#b91c1c" : isIgnoreAction ? "#475569" : styles.optionTitle.color,
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: "8px",
                                  flexWrap: "wrap"
                                }}>
                                  <span>
                                    {isDataMismatch ? `Action ${idx + 1}: ` : `Option ${candidateJobOptions.length + idx + 1}: `}
                                    {cleanUserFacingText(option.title)}
                                  </span>
                                  {isDeleteAction && (
                                    <span style={{ fontSize: "11px", fontWeight: "700", color: "#dc2626", background: "#fee2e2", padding: "2px 8px", borderRadius: "12px", border: "1px solid #fca5a5" }}>
                                      DELETES JOB
                                    </span>
                                  )}
                                </div>

                                {option.explanation && (
                                  <div style={{
                                    ...styles.optionDetail,
                                    marginTop: "8px",
                                    padding: "10px 12px",
                                    backgroundColor: isDeleteAction ? "#fff5f5" : "#fff8e1",
                                    borderLeft: isDeleteAction ? "3px solid #ef4444" : "3px solid #f59e0b",
                                    fontSize: "13px",
                                    lineHeight: "1.5",
                                    borderRadius: "0 6px 6px 0"
                                  }}>
                                    {cleanUserFacingText(option.explanation)}
                                  </div>
                                )}

                                {option.vatUpdate && (
                                  <div style={{ marginTop: "12px", background: "#f0fdf4", border: "1px solid #86efac", borderRadius: "6px", padding: "10px 14px" }}>
                                    <strong style={{ color: "#15803d" }}>If accepted, the following will be updated:</strong>
                                    <div style={{ fontFamily: "monospace", fontSize: "12px", marginTop: "4px" }}>
                                      {option.vatUpdate.cells
                                        ? option.vatUpdate.cells.map(cell => (
                                          <div key={cell}>Cell {cell}: &quot;{option.vatUpdate.currentValue}&quot; → &quot;{option.vatUpdate.newValue}&quot;</div>
                                        ))
                                        : <div>Cell {option.vatUpdate.cell}: &quot;{option.vatUpdate.currentValue}&quot; → &quot;{option.vatUpdate.newValue}&quot;</div>
                                      }
                                    </div>
                                  </div>
                                )}

                                {option.revenueImpact && (
                                  <div style={{ marginTop: "10px", padding: "10px 12px", backgroundColor: "#f0fdf4", borderLeft: "3px solid #16a34a", fontSize: "13px", lineHeight: "1.5", color: "#166534", borderRadius: "0 6px 6px 0" }}>
                                    <strong>Revenue impact:</strong> {cleanUserFacingText(option.revenueImpact)}
                                  </div>
                                )}

                                {option.recommendedActions && option.recommendedActions.length > 0 && !option.vatUpdate && (
                                  <div style={{ ...styles.optionDetail, marginTop: "8px" }}>
                                    <strong>Actions:</strong>
                                    {option.recommendedActions.map((action, i) => (
                                      <div key={i} style={{ marginTop: "4px", fontSize: "13px" }}>
                                        {i === 0 ? <strong style={{ color: "#059669" }}>✓ {cleanUserFacingText(action)}</strong> : `• ${cleanUserFacingText(action)}`}
                                      </div>
                                    ))}
                                  </div>
                                )}

                                <button
                                  className={`triage-btn ${isDeleteAction ? "triage-btn-danger" : isIgnoreAction ? "triage-btn-secondary" : "triage-btn-primary"}`}
                                  onClick={() => {
                                    if (option.matchType === "info") {
                                      const alert2 = clientAlerts[currentClientAlertIndex];
                                      const alertId = `${alert2.sheetName}-${alert2.rowNumber}`;
                                      setProcessedAlerts(new Set([...processedAlerts, alertId]));
                                      if (sessionId) {
                                        fetch("/api/triage", {
                                          method: "POST",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ action: "remove_alert", sessionId, alertId }),
                                          rank: 1,
                                        }).catch(() => { });
                                      }
                                      const updatedAlerts = clientAlerts.filter((_, i) => i !== currentClientAlertIndex);
                                      setClientAlerts(updatedAlerts);
                                      if (updatedAlerts.length === 0) {
                                        if (allNoActionResolved()) { handlePostClear([], resolvedNoActionFlags); }
                                        else { setScreen("alertSelection"); setCurrentClientAlertIndex(0); }
                                      } else { setScreen("alertSelection"); setCurrentClientAlertIndex(0); }
                                    } else {
                                      acceptOption(option);
                                    }
                                  }}
                                  disabled={isAccepting}
                                  style={{
                                    ...styles.decisionButton,
                                    ...(isDeleteAction
                                      ? { backgroundColor: "#dc2626", borderColor: "#b91c1c", color: "white" }
                                      : isIgnoreAction
                                        ? { backgroundColor: "#f1f5f9", borderColor: "#cbd5e1", color: "#475569" }
                                        : styles.approveButton),
                                    marginTop: "12px",
                                    width: "100%",
                                    opacity: isAccepting ? 0.5 : 1
                                  }}
                                >
                                  {isAccepting ? (
                                    <><Spinner color="white" />Writing to sheet...</>
                                  ) : (
                                    option.actionButtonText || (option.matchType === "info" ? "✓ Mark as resolved" : `✓ Accept ${isDataMismatch ? 'action' : 'option'} ${candidateJobOptions.length + idx + 1}`)
                                  )}
                                </button>
                              </div>
                            );
                          })}

                          {/* 3. Other Action Cards (Modeled on CRM Missing Job Layout - Missing items only) */}
                          {(isInvoiceType || isExpenseType) && !isDataMismatch && (
                            <div style={{ marginTop: "16px", paddingTop: "14px", borderTop: "1px solid #e2e8f0" }}>
                              <div style={{ fontSize: "14px", fontWeight: "700", color: "#334155", marginBottom: "10px" }}>
                                Other actions
                              </div>
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "12px" }}>
                                {/* Search all confirmed jobs */}
                                <div style={{ background: "#ffffff", border: "1px solid #fdba74", borderRadius: "8px", padding: "14px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                                  <div>
                                    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                                      <span style={{ fontSize: "16px" }}>🔍</span>
                                      <strong style={{ color: "#c2410c", fontSize: "14px" }}>Search all confirmed jobs</strong>
                                    </div>
                                    <p style={{ fontSize: "12px", color: "#4b5563", margin: "4px 0 12px 0", lineHeight: "1.4" }}>
                                      Search and select any job across the entire client list if this {isInvoiceType ? "invoice" : "expense"} belongs to a different job.
                                    </p>
                                  </div>
                                  <button
                                    type="button"
                                    className="triage-btn"
                                    onClick={() => setExploreJobsOpen(true)}
                                    style={{
                                      ...styles.buttonSecondary,
                                      width: "100%",
                                      padding: "8px 14px",
                                      fontSize: "13px",
                                      fontWeight: "600",
                                      color: "#ea580c",
                                      borderColor: "#fdba74",
                                      background: "#fff7ed",
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      gap: "6px"
                                    }}
                                  >
                                    🔍 Search confirmed jobs
                                  </button>
                                </div>

                                {/* Create new job (Invoices only) */}
                                {isInvoiceType && (
                                  <div style={{ background: "#ffffff", border: "1px solid #93c5fd", borderRadius: "8px", padding: "14px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                                    <div>
                                      <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                                        <span style={{ fontSize: "16px" }}>➕</span>
                                        <strong style={{ color: "#1d4ed8", fontSize: "14px" }}>Create new job</strong>
                                      </div>
                                      <p style={{ fontSize: "12px", color: "#4b5563", margin: "4px 0 12px 0", lineHeight: "1.4" }}>
                                        Add a new job row to the Confirmed tab and assign this invoice directly to it.
                                      </p>
                                    </div>
                                    <button
                                      type="button"
                                      className="triage-btn"
                                      onClick={() => setCreateNewJobOpen(true)}
                                      style={{
                                        ...styles.buttonSecondary,
                                        width: "100%",
                                        padding: "8px 14px",
                                        fontSize: "13px",
                                        fontWeight: "600",
                                        color: "#2563eb",
                                        borderColor: "#93c5fd",
                                        background: "#eff6ff",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: "6px"
                                      }}
                                    >
                                      ➕ Create new job
                                    </button>
                                  </div>
                                )}

                                {/* Place against contractor (Expenses only) */}
                                {isExpenseType && (
                                  <div style={{ background: "#ffffff", border: "1px solid #6ee7b7", borderRadius: "8px", padding: "14px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                                    <div>
                                      <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                                        <span style={{ fontSize: "16px" }}>👷</span>
                                        <strong style={{ color: "#047857", fontSize: "14px" }}>Place against contractor</strong>
                                      </div>
                                      <p style={{ fontSize: "12px", color: "#4b5563", margin: "4px 0 12px 0", lineHeight: "1.4" }}>
                                        Place on the Outgoings sheet if this is an agency contractor rather than a direct job cost.
                                      </p>
                                    </div>
                                    <button
                                      type="button"
                                      className="triage-btn"
                                      onClick={() => setOutgoingsPickerOpen(true)}
                                      style={{
                                        ...styles.buttonSecondary,
                                        width: "100%",
                                        padding: "8px 14px",
                                        fontSize: "13px",
                                        fontWeight: "600",
                                        color: "#059669",
                                        borderColor: "#6ee7b7",
                                        background: "#ecfdf5",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        gap: "6px"
                                      }}
                                    >
                                      👷 Select contractor on outgoings
                                    </button>
                                  </div>
                                )}

                                {/* Ignore alert / deal */}
                                <div style={{ background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "8px", padding: "14px", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                                  <div>
                                    <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "4px" }}>
                                      <span style={{ fontSize: "16px" }}>🚫</span>
                                      <strong style={{ color: "#475569", fontSize: "14px" }}>Ignore alert</strong>
                                    </div>
                                    <p style={{ fontSize: "12px", color: "#64748b", margin: "4px 0 12px 0", lineHeight: "1.4" }}>
                                      Dismiss this alert if this transaction does not belong in Pulse tracking.
                                    </p>
                                  </div>
                                  <button
                                    type="button"
                                    className="triage-btn"
                                    onClick={() => setShowIgnoreModal(true)}
                                    style={{
                                      ...styles.buttonSecondary,
                                      width: "100%",
                                      padding: "8px 14px",
                                      fontSize: "13px",
                                      fontWeight: "600",
                                      color: "#64748b",
                                      borderColor: "#cbd5e1",
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      gap: "6px"
                                    }}
                                  >
                                    🚫 Ignore alert
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    }
                  } catch (e) {
                    // Show as plain text if not JSON
                    return (
                      <div style={styles.claudeAnalysis}>
                        {claudeAnalysis.split('\n').map((line, idx) => (
                          <div key={idx}>{line || <br />}</div>
                        ))}
                      </div>
                    );
                  }
                })()}
              </>
            )}
          </div>
        )}

        {isAnalyzing && (
          <div style={{ ...styles.claudeAnalysis, textAlign: "center", color: "#666" }}>
            Generating options for this alert...
          </div>
        )}

        <div style={{ marginTop: "16px", display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <button className="triage-btn"
            onClick={() => {
              const updatedAlerts = clientAlerts.filter((_, idx) => idx !== currentClientAlertIndex);
              setClientAlerts(updatedAlerts);
              setCurrentClientAlertIndex(0);
              if (updatedAlerts.length === 0) {
                if (allNoActionResolved()) { handlePostClear([], resolvedNoActionFlags); }
                else setScreen("alertSelection");
              } else { setScreen("alertSelection"); }
            }}
            style={{ ...styles.buttonSecondary, color: "#d97706", borderColor: "#d97706" }}
          >
            ⏭ Skip Alert
          </button>
          <button className="triage-btn"
            onClick={() => setShowIgnoreModal(true)}
            style={{ ...styles.buttonSecondary, color: "#c62828", borderColor: "#ef9a9a" }}
          >
            🚫 Ignore Forever
          </button>
          <button className="triage-btn"
            onClick={() => openCreateTaskModal(clientAlerts[currentClientAlertIndex], false)}
            style={{ ...styles.buttonSecondary, color: "#7c3aed", borderColor: "#c4b5fd" }}
          >
            📋 Create Task
          </button>
          {isAdmin && (selectedClient?.clientSheetId || selectedClient?.masterSheetId) && (
            <button className="triage-btn"
              onClick={() => {
                const clientUrl = selectedClient.clientSheetId
                  ? `https://docs.google.com/spreadsheets/d/${selectedClient.clientSheetId}/edit`
                  : null;
                const masterUrl = selectedClient.masterSheetId
                  ? `https://docs.google.com/spreadsheets/d/${selectedClient.masterSheetId}/edit`
                  : null;
                if (clientUrl) window.open(clientUrl, "_blank");
                if (masterUrl) window.open(masterUrl, "_blank");
              }}
              style={{ ...styles.buttonSecondary, color: "#1d4ed8", borderColor: "#93c5fd" }}
            >
              📊 Open Sheets
            </button>
          )}

          {/* Re-run analysis button */}
          <button className="triage-btn" disabled={isAnalyzing}
            onClick={async () => {
              setIsAnalyzing(true);
              setClaudeAnalysis("");
              try {
                const res = await fetch("/api/triage", {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "analyze_alert", alert, automationCommanderSheetId, forceFresh: true }),
                });
                const d = await res.json();
                if (d.success) {
                  const pir = d.previousIgnoreReason;
                  setPreviousIgnoreReason(pir && typeof pir === "object" ? pir : pir ? { ignoreReason: pir, changeReason: null } : null);
                  setClaudeAnalysis(JSON.stringify(d.options || [], null, 2));
                  setClientAlerts(prev => {
                    const newAlerts = [...prev];
                    const idx = newAlerts.findIndex(a => a.sheetName === alert.sheetName && a.rowNumber === alert.rowNumber);
                    if (idx !== -1) {
                      newAlerts[idx] = { ...newAlerts[idx], options: d.options };
                    }
                    return newAlerts;
                  });
                } else {
                  setClaudeAnalysis("Error: " + (d.error || "Unknown error"));
                }
              } catch (e) {
                setClaudeAnalysis("Error: " + e.message);
              } finally {
                setIsAnalyzing(false);
              }
            }}
            style={{
              ...styles.buttonSecondary, color: "#4b5563", borderColor: "#cbd5e1",
              opacity: isAnalyzing ? 0.6 : 1
            }}>
            ↻ Re-run
          </button>

          {/* Use AI button - shown only to Admins for alert types that previously used Claude */}
          {isAdmin && claudeAnalysis && (() => {
            const alert = clientAlerts[currentClientAlertIndex];
            const ft = alert?.flagType || alert?.alertType || alert?.type || "";
            const aiTypes = new Set(["invoiceDashboardDiscr", "expenseDashboardDiscr",
              "crmPipeDashDiscr", "crmConfDashDiscr", "crmPipeAppDiscr", "crmConfAppDiscr"]);
            if (!aiTypes.has(ft)) return null;
            return (
              <button className="triage-btn" disabled={isAnalyzing}
                onClick={async () => {
                  setIsAnalyzing(true);
                  setClaudeAnalysis("");
                  try {
                    const res = await fetch("/api/triage", {
                      method: "POST", headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "analyze_alert_ai", alert, automationCommanderSheetId }),
                    });
                    const d = await res.json();
                    if (d.success) {
                      const pir = d.previousIgnoreReason;
                      setPreviousIgnoreReason(pir && typeof pir === "object" ? pir : pir ? { ignoreReason: pir, changeReason: null } : null);
                      setClaudeAnalysis(JSON.stringify(d.options || [], null, 2));
                    } else {
                      setClaudeAnalysis("Error: " + (d.error || "Unknown error"));
                    }
                  } catch (e) { setClaudeAnalysis("Error: " + e.message); }
                  finally { setIsAnalyzing(false); }
                }}
                style={{
                  ...styles.buttonSecondary, color: "#059669", borderColor: "#6ee7b7",
                  opacity: isAnalyzing ? 0.6 : 1
                }}>
                🤖 Use AI
              </button>
            );
          })()}
        </div>

        {/* Existing task banner */}
        {existingTaskBanner && (
          <div style={{ marginTop: "12px", padding: "12px 16px", background: "#f3e8ff", border: "1px solid #c4b5fd", borderRadius: "6px" }}>
            <div style={{ fontSize: "13px", fontWeight: "600", color: "#7c3aed", marginBottom: "6px" }}>
              📋 This alert has an existing task{existingTaskBanner.dataChanged ? " - underlying data has changed since the task was created" : ""}
            </div>
            <div style={{ fontSize: "12px", color: "#555", marginBottom: "8px" }}>
              Created: {existingTaskBanner.taskCreatedAt ? new Date(existingTaskBanner.taskCreatedAt).toLocaleDateString("en-GB") : "unknown"}
              {existingTaskBanner.taskNote ? ` · Note: "${existingTaskBanner.taskNote}"` : ""}
              {existingTaskBanner.isSnoozed ? ` · Snoozed until ${new Date(existingTaskBanner.snoozedUntil).toLocaleString("en-GB")}` : ""}
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button className="triage-btn" onClick={() => { handleNavTasks(); setActiveNav("tasks"); }}
                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px", color: "#7c3aed", borderColor: "#c4b5fd" }}>
                View Task
              </button>
              {existingTaskBanner.dataChanged && (
                <>
                  <button className="triage-btn"
                    onClick={async () => {
                      const alert = clientAlerts[currentClientAlertIndex];
                      await fetch("/api/triage", {
                        method: "POST", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          action: "update_task",
                          fingerprintHash: existingTaskBanner.fingerprintHash,
                          newCachedOptionsJSON: claudeAnalysis,
                          newAlertData: JSON.stringify(alert),
                          unsnooze: false,
                          automationCommanderSheetId,
                        }),
                      });
                      setExistingTaskBanner(prev => ({ ...prev, dataChanged: false }));
                    }}
                    style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px" }}>
                    Update Task
                  </button>
                  {existingTaskBanner.isSnoozed && (
                    <button className="triage-btn"
                      onClick={async () => {
                        const alert = clientAlerts[currentClientAlertIndex];
                        await fetch("/api/triage", {
                          method: "POST", headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            action: "update_task",
                            fingerprintHash: existingTaskBanner.fingerprintHash,
                            newCachedOptionsJSON: claudeAnalysis,
                            newAlertData: JSON.stringify(alert),
                            unsnooze: true,
                            automationCommanderSheetId,
                          }),
                        });
                        setExistingTaskBanner(prev => ({ ...prev, dataChanged: false, isSnoozed: false }));
                      }}
                      style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px", color: "#7c3aed", borderColor: "#c4b5fd" }}>
                      Update &amp; Unsnooze
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* Ignore reason modal */}
        {showIgnoreModal && (
          <div style={styles.modalOverlay} onClick={(e) => { if (e.target === e.currentTarget) setShowIgnoreModal(false); }}>
            <div style={styles.modalCard}>
              <h3 style={styles.modalTitle}>Permanently Ignore Alert</h3>
              <p style={styles.modalSubtitle}>
                This alert will be hidden from all future triage runs unless its underlying data changes.
                Optionally add a reason for your records.
              </p>
              <textarea
                value={ignoreReason}
                onChange={(e) => setIgnoreReason(e.target.value)}
                placeholder="Reason for ignoring (optional)..."
                style={styles.modalTextarea}
                autoFocus
              />
              <div style={styles.modalButtons}>
                <button className="triage-btn"
                  onClick={() => { setShowIgnoreModal(false); setIgnoreReason(""); }}
                  style={styles.buttonSecondary}
                >
                  Cancel
                </button>
                <button className="triage-btn"
                  onClick={ignoreAlert}
                  disabled={isIgnoring}
                  style={{ ...styles.ignoreButton, opacity: isIgnoring ? 0.5 : 1 }}
                >
                  {isIgnoring ? <><Spinner />Ignoring...</> : "🚫 Confirm Ignore"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Explore all Confirmed jobs modal */}
        {exploreJobsOpen && (
          <ExploreJobsModal
            isOpen={exploreJobsOpen}
            onClose={() => setExploreJobsOpen(false)}
            clientSheetId={targetClientSheetId}
            clientName={selectedClient?.clientName}
            mode={isExpenseType ? "expense" : "invoice"}
            alertItem={alert}
            onSelectSlot={(jobRow, slotNum, slot, rowNum, createNewRow, customLabel) => {
              handleInitiatePlaceOnJob(jobRow, slotNum, slot, rowNum, createNewRow, customLabel);
            }}
            onViewJob={(job) => {
              setViewingJobTarget({
                clientSheetId: targetClientSheetId,
                clientName: job.client || selectedClient?.clientName,
                jobName: job.jobName,
                rowNum: job.rowNum,
                rowNumber: job.rowNum,
                tabName: "Confirmed"
              });
            }}
            isAdmin={isAdmin}
          />
        )}

        {/* Create new job from invoice modal */}
        {createNewJobOpen && (
          <InvoicesNewJobModal
            newJobData={{
              inv: {
                invoiceNo: alert?.summary?.invoiceNo || alert?.data?.accounting?.[5] || "",
                amount: parseFloat(String(alert?.summary?.amount || alert?.data?.accounting?.[2] || "0").replace(/[£$€,\s]/g, "")) || 0,
                client: alert?.summary?.client || alert?.data?.accounting?.[0] || selectedClient?.clientName || "",
                job: alert?.summary?.job || alert?.data?.accounting?.[1] || "",
                sentDate: alert?.summary?.sentDate || alert?.data?.accounting?.[6] || "",
                dueDate: alert?.summary?.dueDate || alert?.data?.accounting?.[7] || "",
                status: alert?.summary?.status || alert?.data?.accounting?.[9] || "Sent",
                vatAmount: (alert?.summary?.vatAmount && parseFloat(String(alert.summary.vatAmount).replace(/,/g, "")) > 0)
                  ? parseFloat(String(alert.summary.vatAmount).replace(/,/g, ""))
                  : (alert?.data?.accounting?.[8] ? parseFloat(String(alert.data.accounting[8]).replace(/,/g, "")) : 0),
              }
            }}
            invoicesClient={{
              clientSheetId: targetClientSheetId,
              clientName: selectedClient?.clientName || clientInfo?.clientName || "",
              masterSheetId: clientInfo?.masterSheetId || selectedClient?.masterSheetId || "",
              automationCommanderSheetId,
            }}
            onClose={() => setCreateNewJobOpen(false)}
            onMarkPullPending={() => {}}
            onSuccess={async (inv) => {
              setCreateNewJobOpen(false);
              const invIdentifier = inv?.invoiceNo ? `invoice #${inv.invoiceNo}` : "invoice";
              await handleResolveAlertAfterPlacement(alert, `Created new job for ${invIdentifier}`);
            }}
          />
        )}

        {/* Outgoings Contractor Grid Picker Modal */}
        {outgoingsPickerOpen && (
          <OutgoingsContractorPickerModal
            isOpen={outgoingsPickerOpen}
            onClose={() => setOutgoingsPickerOpen(false)}
            clientSheetId={targetClientSheetId}
            clientName={selectedClient?.clientName}
            expense={{
              vendor: alert?.summary?.description || alert?.summary?.reference || alert?.data?.accounting?.[1] || "",
              description: alert?.summary?.description || alert?.summary?.reference || alert?.data?.accounting?.[1] || "",
              date: alert?.summary?.date || alert?.data?.accounting?.[0] || "",
              amount: parseFloat(String(alert?.summary?.amount || alert?.data?.accounting?.[2] || "0").replace(/[£$€,\s]/g, "")) || 0
            }}
            onSelectCell={(data) => {
              handleInitiatePlaceOnContractor(data);
            }}
            isAdmin={isAdmin}
          />
        )}

        {/* Confirm Placement Dialog */}
        {placementPrompt && (
          <div
            style={styles.modalOverlay}
            onClick={(e) => {
              if (e.target === e.currentTarget && !isSavingPlacement) {
                setPlacementPrompt(null);
              }
            }}
          >
            <div style={{ ...styles.modalCard, maxWidth: "520px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
                <span style={{ fontSize: "24px" }}>
                  {placementPrompt.type === "invoice" ? "📄" : placementPrompt.type === "expense_contractor" ? "👷" : "📦"}
                </span>
                <div>
                  <h3 style={{ ...styles.modalTitle, margin: 0 }}>Confirm Placement</h3>
                  <p style={{ ...styles.modalSubtitle, margin: 0 }}>
                    Please confirm where this {placementPrompt.type === "invoice" ? "invoice" : "expense"} will be placed.
                  </p>
                </div>
              </div>

              {/* Placement details card */}
              <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "14px", marginBottom: "16px" }}>
                {placementPrompt.type === "invoice" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px" }}>
                    <div>
                      <span style={{ color: "#64748b" }}>Target Job: </span>
                      <strong style={{ color: "#0f172a" }}>{placementPrompt.jobName}</strong>
                      <span style={{ color: "#64748b" }}> ({placementPrompt.jobClient})</span>
                    </div>
                    <div>
                      <span style={{ color: "#64748b" }}>Placement Target: </span>
                      <span style={{ display: "inline-block", background: "#f0fdf4", border: "1px solid #86efac", padding: "2px 8px", borderRadius: "4px", fontWeight: "600", color: "#166534" }}>
                        {placementPrompt.slotLabel || (placementPrompt.createNewRow ? "New Invoice Entry" : "Invoice Entry")}
                      </span>
                    </div>
                    {placementPrompt.slot && (placementPrompt.slot.ref || (placementPrompt.slot.amount && parseFloat(placementPrompt.slot.amount) > 0)) && (
                      <div style={{ padding: "6px 10px", background: "#fffbeb", border: "1px solid #fef3c7", borderRadius: "6px", fontSize: "12px", color: "#92400e" }}>
                        ⚠️ <strong>Notice:</strong> This entry currently has Invoice #{placementPrompt.slot.ref || "(no number)"} (£{parseFloat(placementPrompt.slot.amount || 0).toLocaleString()}). Confirming will update this entry with the incoming invoice details.
                      </div>
                    )}
                    <div style={{ height: "1px", background: "#e2e8f0", margin: "4px 0" }} />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                      <div>
                        <span style={{ color: "#64748b", fontSize: "12px" }}>Invoice #:</span>
                        <div style={{ fontWeight: "600", color: "#0f172a" }}>#{placementPrompt.invoiceNo || "N/A"}</div>
                      </div>
                      <div>
                        <span style={{ color: "#64748b", fontSize: "12px" }}>Amount:</span>
                        <div style={{ fontWeight: "700", color: "#16a34a" }}>£{parseFloat(placementPrompt.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                      </div>
                      <div>
                        <span style={{ color: "#64748b", fontSize: "12px" }}>Sent Date:</span>
                        <div style={{ fontWeight: "500", color: "#334155" }}>{placementPrompt.sentDate || "Not recorded"}</div>
                      </div>
                      <div>
                        <span style={{ color: "#64748b", fontSize: "12px" }}>Status:</span>
                        <div style={{ fontWeight: "500", color: "#334155" }}>{placementPrompt.status || "Sent"}</div>
                      </div>
                    </div>
                  </div>
                )}

                {placementPrompt.type === "expense_job" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px" }}>
                    <div>
                      <span style={{ color: "#64748b" }}>Target Job: </span>
                      <strong style={{ color: "#0f172a" }}>{placementPrompt.jobName}</strong>
                      <span style={{ color: "#64748b" }}> ({placementPrompt.jobClient})</span>
                    </div>
                    <div>
                      <span style={{ color: "#64748b" }}>Placement Target: </span>
                      <span style={{ display: "inline-block", background: "#fffbeb", border: "1px solid #fcd34d", padding: "2px 8px", borderRadius: "4px", fontWeight: "600", color: "#92400e" }}>
                        {placementPrompt.slotLabel || (placementPrompt.createNewRow ? "New Direct Cost" : "Direct Cost Entry")}
                      </span>
                    </div>
                    {placementPrompt.slot && (placementPrompt.slot.description || (placementPrompt.slot.amount && parseFloat(placementPrompt.slot.amount) > 0)) && (
                      <div style={{ padding: "6px 10px", background: "#fffbeb", border: "1px solid #fef3c7", borderRadius: "6px", fontSize: "12px", color: "#92400e" }}>
                        ⚠️ <strong>Notice:</strong> This entry currently has {placementPrompt.slot.description || "an expense"} (£{parseFloat(placementPrompt.slot.amount || 0).toLocaleString()}). Confirming will update this entry with the incoming expense.
                      </div>
                    )}
                    <div style={{ height: "1px", background: "#e2e8f0", margin: "4px 0" }} />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                      <div style={{ gridColumn: "span 2" }}>
                        <span style={{ color: "#64748b", fontSize: "12px" }}>Description:</span>
                        <div style={{ fontWeight: "600", color: "#0f172a" }}>{placementPrompt.description || "N/A"}</div>
                      </div>
                      <div>
                        <span style={{ color: "#64748b", fontSize: "12px" }}>Amount:</span>
                        <div style={{ fontWeight: "700", color: "#dc2626" }}>£{parseFloat(placementPrompt.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                      </div>
                      <div>
                        <span style={{ color: "#64748b", fontSize: "12px" }}>Date:</span>
                        <div style={{ fontWeight: "500", color: "#334155" }}>{placementPrompt.date || "Not recorded"}</div>
                      </div>
                      <div>
                        <span style={{ color: "#64748b", fontSize: "12px" }}>VAT:</span>
                        <div style={{ fontWeight: "500", color: "#334155" }}>{placementPrompt.vat || "No"}</div>
                      </div>
                      <div>
                        <span style={{ color: "#64748b", fontSize: "12px" }}>Status:</span>
                        <div style={{ fontWeight: "500", color: "#334155" }}>{placementPrompt.status || "Received"}</div>
                      </div>
                    </div>
                  </div>
                )}

                {placementPrompt.type === "expense_contractor" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px" }}>
                    <div>
                      <span style={{ color: "#64748b" }}>Target Contractor: </span>
                      <strong style={{ color: "#0f172a" }}>{placementPrompt.contractorName}</strong>
                    </div>
                    <div>
                      <span style={{ color: "#64748b" }}>Target Month: </span>
                      <span style={{ display: "inline-block", background: "#ecfdf5", border: "1px solid #a7f3d0", padding: "2px 8px", borderRadius: "4px", fontWeight: "600", color: "#065f46" }}>
                        {placementPrompt.monthLabel}
                      </span>
                    </div>
                    <div style={{ height: "1px", background: "#e2e8f0", margin: "4px 0" }} />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                      <div style={{ gridColumn: "span 2" }}>
                        <span style={{ color: "#64748b", fontSize: "12px" }}>Description:</span>
                        <div style={{ fontWeight: "600", color: "#0f172a" }}>{placementPrompt.description || "N/A"}</div>
                      </div>
                      <div>
                        <span style={{ color: "#64748b", fontSize: "12px" }}>Amount:</span>
                        <div style={{ fontWeight: "700", color: "#dc2626" }}>£{parseFloat(placementPrompt.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                      </div>
                      <div>
                        <span style={{ color: "#64748b", fontSize: "12px" }}>Date:</span>
                        <div style={{ fontWeight: "500", color: "#334155" }}>{placementPrompt.date || "Not recorded"}</div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {acceptError && (
                <div style={{ marginBottom: "12px", padding: "8px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "6px", color: "#dc2626", fontSize: "12px" }}>
                  {acceptError}
                </div>
              )}

              {/* Modal action buttons */}
              <div style={styles.modalButtons}>
                <button
                  type="button"
                  className="triage-btn"
                  onClick={() => setPlacementPrompt(null)}
                  disabled={isSavingPlacement}
                  style={styles.buttonSecondary}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="triage-btn"
                  onClick={executeConfirmedPlacement}
                  disabled={isSavingPlacement}
                  style={{
                    ...styles.decisionButton,
                    ...styles.approveButton,
                    background: "#16a34a",
                    borderColor: "#15803d",
                    padding: "8px 16px",
                    opacity: isSavingPlacement ? 0.6 : 1,
                    display: "flex",
                    alignItems: "center",
                    gap: "6px"
                  }}
                >
                  {isSavingPlacement ? (
                    <>
                      <Spinner />
                      <span>Placing...</span>
                    </>
                  ) : (
                    "✓ Confirm & Place"
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Confirm Job Creation Dialog */}
        {confirmJobModal && (
          <div
            style={styles.modalOverlay}
            onClick={(e) => {
              if (e.target === e.currentTarget && !isSavingPlacement) {
                setConfirmJobModal(null);
              }
            }}
          >
            <div style={{ ...styles.modalCard, maxWidth: "520px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "12px" }}>
                <span style={{ fontSize: "24px" }}>➕</span>
                <div>
                  <h3 style={{ ...styles.modalTitle, margin: 0 }}>Confirm Job Creation</h3>
                  <p style={{ ...styles.modalSubtitle, margin: 0 }}>
                    Create a new job in Pulse based on this CRM deal.
                  </p>
                </div>
              </div>

              {/* Job details summary card */}
              <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "14px", marginBottom: "16px" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: "10px", fontSize: "13px" }}>
                  <div>
                    <span style={{ color: "#64748b", fontSize: "12px" }}>Client:</span>
                    <div style={{ fontWeight: "700", color: "#0f172a", fontSize: "14px" }}>{confirmJobModal.client}</div>
                  </div>
                  <div>
                    <span style={{ color: "#64748b", fontSize: "12px" }}>Job Name:</span>
                    <div style={{ fontWeight: "600", color: "#0f172a" }}>{confirmJobModal.jobName}</div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                    <div>
                      <span style={{ color: "#64748b", fontSize: "12px" }}>Project Code:</span>
                      <div style={{ fontWeight: "500", color: "#334155" }}>{confirmJobModal.projectCode || "Auto-assigned"}</div>
                    </div>
                    <div>
                      <span style={{ color: "#64748b", fontSize: "12px" }}>Job Type / Tab:</span>
                      <div style={{ display: "inline-block", background: "#f1f5f9", padding: "2px 8px", borderRadius: "4px", fontWeight: "600", color: "#334155" }}>
                        {confirmJobModal.projectRetainer} ({confirmJobModal.tabName})
                      </div>
                    </div>
                    <div>
                      <span style={{ color: "#64748b", fontSize: "12px" }}>Revenue:</span>
                      <div style={{ fontWeight: "700", color: "#16a34a" }}>
                        £{parseFloat(confirmJobModal.revenue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                    </div>
                    <div>
                      <span style={{ color: "#64748b", fontSize: "12px" }}>Direct Costs:</span>
                      <div style={{ fontWeight: "700", color: "#dc2626" }}>
                        £{parseFloat(confirmJobModal.directCosts || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                    </div>
                    {confirmJobModal.startDate && (
                      <div>
                        <span style={{ color: "#64748b", fontSize: "12px" }}>Start Date:</span>
                        <div style={{ fontWeight: "500", color: "#334155" }}>{confirmJobModal.startDate}</div>
                      </div>
                    )}
                    {confirmJobModal.endDate && (
                      <div>
                        <span style={{ color: "#64748b", fontSize: "12px" }}>End Date:</span>
                        <div style={{ fontWeight: "500", color: "#334155" }}>{confirmJobModal.endDate}</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {acceptError && (
                <div style={{ marginBottom: "12px", padding: "8px 12px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: "6px", color: "#dc2626", fontSize: "12px" }}>
                  {acceptError}
                </div>
              )}

              {/* Modal action buttons */}
              <div style={styles.modalButtons}>
                <button
                  type="button"
                  className="triage-btn"
                  onClick={() => setConfirmJobModal(null)}
                  disabled={isSavingPlacement}
                  style={styles.buttonSecondary}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="triage-btn"
                  onClick={executeConfirmedJobCreation}
                  disabled={isSavingPlacement}
                  style={{
                    ...styles.decisionButton,
                    ...styles.approveButton,
                    background: "#7c3aed",
                    borderColor: "#6d28d9",
                    padding: "8px 16px",
                    opacity: isSavingPlacement ? 0.6 : 1,
                    display: "flex",
                    alignItems: "center",
                    gap: "6px"
                  }}
                >
                  {isSavingPlacement ? (
                    <>
                      <Spinner />
                      <span>Creating Job...</span>
                    </>
                  ) : (
                    "✓ Confirm & Create Job"
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Job Detail Modal for "View Job" */}
        {viewingJobTarget && (
          <JobDetailModal
            isOpen={!!viewingJobTarget}
            target={viewingJobTarget}
            onClose={() => setViewingJobTarget(null)}
          />
        )}
      </div>
    </div>
  );
}