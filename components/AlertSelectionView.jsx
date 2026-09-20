import React, { useState } from "react";
import Spinner from "./Spinner";
import TruncatedCode from "./TruncatedCode";
import RetainerAlertResolutionModal from "./RetainerAlertResolutionModal";
import RetainerSplitInvoiceModal from "./RetainerSplitInvoiceModal";
import { useBulkActions } from "../hooks/useBulkActions";
import { useTasks } from "../contexts/TaskContext";
import { useTriage } from "../contexts/TriageContext";
import { useAppGlobals } from "../hooks/useAppGlobals";

const RICH_NOACTION_FLAG_GROUP = {
  crmCopiedConfChecked:    "crm",
  crmCopiedConfUnchecked:  "crm",
  crmCopiedConfDelete:     "crm",
  retainerInvoicesCreated: "invoice",
  retainerInvoicesDeleted: "invoice",
  invoiceStaleUnsentChanges: "invoice",
};

export default function AlertSelectionView({
  styles, setScreen, getFlagName, getAlertSummary,
  PROACTIVE_TYPE_LABELS, openCreateTaskModal, setActiveNav
}) {
  const [retainerAlertResolution, setRetainerAlertResolution] = useState(null);
  const [retainerSplitInvoice, setRetainerSplitInvoice] = useState(null);

  const { setNavTaskCount, setSnoozedTaskCount } = useTasks();
  const { allClientsMap, automationCommanderSheetId } = useAppGlobals();
  
  const {
    selectedClient, clientAlerts, setClientAlerts, clientNoActionAlerts, proactiveAlerts,
    setProactiveAlerts, setProactiveCountsByClient, groupedAlerts, clientsWithFlags,
    acceptError, setAcceptError, selectAlert, resolvedNoActionFlags, setResolvedNoActionFlags,
    setClientsWithFlags, sessionId, autoClearFlags, handlePostClear, noActionAnalysis,
    noActionAnalysisLoading, analyzeNoActionFlag, setProcessedAlerts, allNoActionResolved,
    loadProactiveAlerts
  } = useTriage();
  const {
    bulkMode, setBulkMode, bulkSelected, setBulkSelected,
    showBulkIgnoreModal, setShowBulkIgnoreModal, showBulkTaskModal, setShowBulkTaskModal,
    bulkIgnoreReason, setBulkIgnoreReason, bulkTaskNote, setBulkTaskNote,
    bulkTaskSnoozeDate, setBulkTaskSnoozeDate, bulkTaskSnoozeTime, setBulkTaskSnoozeTime,
    bulkSubmitting, setBulkSubmitting,
    proactiveBulkMode, setProactiveBulkMode, proactiveBulkSelected, setProactiveBulkSelected,
    proactiveBulkSubmitting, setProactiveBulkSubmitting, showProactiveBulkTaskModal, setShowProactiveBulkTaskModal,
    proactiveBulkTaskNote, setProactiveBulkTaskNote, proactiveBulkTaskSnoozeDate, setProactiveBulkTaskSnoozeDate,
    proactiveBulkTaskSnoozeTime, setProactiveBulkTaskSnoozeTime,
    infoBulkMode, setInfoBulkMode, infoBulkSelected, setInfoBulkSelected,
    infoBulkSubmitting, setInfoBulkSubmitting, showInfoBulkTaskModal, setShowInfoBulkTaskModal,
    infoBulkTaskNote, setInfoBulkTaskNote, infoBulkTaskSnoozeDate, setInfoBulkTaskSnoozeDate,
    infoBulkTaskSnoozeTime, setInfoBulkTaskSnoozeTime
  } = useBulkActions();

  const acknowledgeProactiveAlert = async (alertKey, rowIndex) => {
    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "acknowledge_proactive_alert", alertKey, automationCommanderSheetId }),
      });
      const data = await res.json();
      if (!data.success) {
        console.error(`❌ acknowledge_proactive_alert failed: ${data.error}`);
        return;
      }
      console.log(`✅ Acknowledged alert: ${alertKey} (rowIndex ${rowIndex})`);
      
      if (sessionId) {
        fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "remove_alert", sessionId, alertId: alertKey }),
        }).catch(() => {});
      }

      const remaining = (rowIndex != null)
        ? proactiveAlerts.filter(a => a.rowIndex !== rowIndex)
        : proactiveAlerts.filter(a => a.alertKey !== alertKey);
      const counts = {};
      remaining.forEach(a => { 
        const cName = a.clientName || a.metadata?.endClientName || a.metadata?.clientName;
        if (cName) counts[cName] = (counts[cName] || 0) + 1; 
      });
      setProactiveCountsByClient(counts);
      setProactiveAlerts(remaining);
      const remainingProactiveCount = remaining.filter(a => a.clientName === selectedClient?.clientName).length;

      const infoDone = clientNoActionAlerts.every(na => resolvedNoActionFlags.has(na.fingerprintHash || `${na.flagType}-${na.flagDetail || ""}`));
      if (clientAlerts.length === 0 && infoDone && remainingProactiveCount === 0) {
        handlePostClear([], resolvedNoActionFlags);
      }
    } catch (err) {
      console.error("Failed to acknowledge proactive alert:", err);
    }
  };

  const markPipelineCopied = async (alert) => {
    const md = alert.metadata || {};
    const clientInfo = (clientsWithFlags || []).find(c => c.clientName === alert.clientName) || allClientsMap[alert.clientName];
    if (!md.pipelineRow || !clientInfo?.clientSheetId) {
      console.error("Cannot mark pipeline copied: missing pipelineRow or clientSheetId");
      return;
    }
    try {
      const res = await fetch("/api/triage", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_pipeline_copied", clientSheetId: clientInfo.clientSheetId, pipelineRow: md.pipelineRow }),
      });
      const data = await res.json();
      if (!data.success) {
        console.error(`❌ mark_pipeline_copied failed: ${data.error}`);
        return;
      }
      console.log(`✅ Marked Pipeline row ${md.pipelineRow} as copied to confirmed`);
      
      if (alert.alertKey && automationCommanderSheetId) {
        try {
          await fetch("/api/triage", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "resolve_proactive_alert", automationCommanderSheetId, alertKey: alert.alertKey, resolution: "Marked \"Copied to confirmed?\" = Yes in Pipeline" }),
          });
        } catch (resolveErr) { console.error("Failed to mark alert resolved:", resolveErr); }
      }

      const remaining = proactiveAlerts.filter(a => a.rowIndex !== alert.rowIndex);
      const counts = {};
      remaining.forEach(a => { 
        const cName = a.clientName || a.metadata?.endClientName || a.metadata?.clientName;
        if (cName) counts[cName] = (counts[cName] || 0) + 1; 
      });
      setProactiveCountsByClient(counts);
      setProactiveAlerts(remaining);
      const remainingProactiveCount = remaining.filter(a => a.clientName === selectedClient?.clientName).length;

      const infoDone = clientNoActionAlerts.every(na => resolvedNoActionFlags.has(na.fingerprintHash || `${na.flagType}-${na.flagDetail || ""}`));
      if (clientAlerts.length === 0 && infoDone && remainingProactiveCount === 0) {
        handlePostClear([], resolvedNoActionFlags);
      }
    } catch (err) {
      console.error("Failed to mark pipeline copied:", err);
    }
  };

  const clientProactiveAlertsList = proactiveAlerts.filter(a => a.clientName === selectedClient.clientName);
  const freqLabel = (days) => {
    if (days <= 31) return "monthly";
    if (days <= 65) return "bi-monthly";
    if (days <= 95) return "quarterly";
    if (days <= 190) return "semi-annual";
    return "annual";
  };

  const groupedInfoAlerts = {};
  clientNoActionAlerts.forEach(na => {
    const type = na.flagType || "unknown";
    if (!groupedInfoAlerts[type]) groupedInfoAlerts[type] = [];
    groupedInfoAlerts[type].push(na);
  });

  const groupedProactiveAlerts = {};
  clientProactiveAlertsList.forEach(pa => {
    const type = pa.alertType || "unknown";
    if (!groupedProactiveAlerts[type]) groupedProactiveAlerts[type] = [];
    groupedProactiveAlerts[type].push(pa);
  });

  const getBulkSelectedAlerts = () => {
    return clientAlerts.filter(a => bulkSelected.has(a.fingerprintHash || `${a.flagType || a.type}-${a.sheetName}-${a.rowNumber}`));
  };

  const bulkIgnore = async () => {
    const alerts = getBulkSelectedAlerts();
    if (!alerts.length) return;
    try {
      setBulkSubmitting(true);
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bulk_ignore_alerts", alerts, ignoreReason: bulkIgnoreReason, automationCommanderSheetId }),
      });
      const data = await res.json();
      if (!data.success) { setAcceptError(data.error || "Bulk ignore failed"); return; }

      const hashesToRemove = new Set(alerts.map(a => a.fingerprintHash || `${a.flagType || a.type}-${a.sheetName}-${a.rowNumber}`));
      const updatedAlerts = clientAlerts.filter(a => !hashesToRemove.has(a.fingerprintHash || `${a.flagType || a.type}-${a.sheetName}-${a.rowNumber}`));

      if (sessionId) {
        setProcessedAlerts(prev => new Set([...prev, ...hashesToRemove]));
        for (const alert of alerts) {
          const alertId = `${alert.sheetName}-${alert.rowNumber}`;
          fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "remove_alert", sessionId, alertId }) }).catch(() => {});
        }
      }

      const countDeltas = {};
      for (const a of alerts) {
        let ft = a.flagType || a.alertType || a.type || "";
        if (ft === "invoice") ft = "invoiceDashboardDiscr";
        if (ft === "expense") ft = "expenseDashboardDiscr";
        if (ft === "crm") ft = "crmPipeAppDiscr";
        countDeltas[ft] = (countDeltas[ft] || 0) + 1;
      }
      setClientsWithFlags(prev => prev.map(c => {
        if (c.clientName !== selectedClient?.clientName) return c;
        const updatedCounts = { ...c.alertCounts };
        for (const [ft, delta] of Object.entries(countDeltas)) {
          if ((updatedCounts[ft] || 0) > 0) updatedCounts[ft] -= delta;
        }
        return { ...c, alertCounts: updatedCounts };
      }));

      setClientAlerts(updatedAlerts);
      setBulkSelected(new Set());
      setBulkMode(false);
      setShowBulkIgnoreModal(false);
      setBulkIgnoreReason("");

      if (updatedAlerts.length === 0 && allNoActionResolved()) {
        handlePostClear([], resolvedNoActionFlags);
      }
    } catch (err) {
      setAcceptError(`Bulk ignore error: ${err.message}`);
    } finally {
      setBulkSubmitting(false);
    }
  };

  const bulkCreateTasks = async () => {
    const alerts = getBulkSelectedAlerts();
    if (!alerts.length) return;
    try {
      setBulkSubmitting(true);
      const snoozedUntil = bulkTaskSnoozeDate
        ? new Date(`${bulkTaskSnoozeDate}T${bulkTaskSnoozeTime}:00`).toISOString()
        : null;
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "bulk_create_tasks", alerts, taskNote: bulkTaskNote, snoozedUntil, automationCommanderSheetId }),
      });
      const data = await res.json();
      if (!data.success) { setAcceptError(data.error || "Bulk task creation failed"); return; }

      const hashesToRemove = new Set(alerts.map(a => a.fingerprintHash || `${a.flagType || a.type}-${a.sheetName}-${a.rowNumber}`));
      const updatedAlerts = clientAlerts.filter(a => !hashesToRemove.has(a.fingerprintHash || `${a.flagType || a.type}-${a.sheetName}-${a.rowNumber}`));

      if (sessionId) {
        setProcessedAlerts(prev => new Set([...prev, ...hashesToRemove]));
        for (const alert of alerts) {
          const alertId = `${alert.sheetName}-${alert.rowNumber}`;
          fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "remove_alert", sessionId, alertId }) }).catch(() => {});
        }
      }

      const countDeltas = {};
      for (const a of alerts) {
        let ft = a.flagType || a.alertType || a.type || "";
        if (ft === "invoice") ft = "invoiceDashboardDiscr";
        if (ft === "expense") ft = "expenseDashboardDiscr";
        if (ft === "crm") ft = "crmPipeAppDiscr";
        countDeltas[ft] = (countDeltas[ft] || 0) + 1;
      }
      setClientsWithFlags(prev => prev.map(c => {
        if (c.clientName !== selectedClient?.clientName) return c;
        const updatedCounts = { ...c.alertCounts };
        for (const [ft, delta] of Object.entries(countDeltas)) {
          if ((updatedCounts[ft] || 0) > 0) updatedCounts[ft] -= delta;
        }
        return { ...c, alertCounts: updatedCounts };
      }));

      const tasksAdded = (data.results || []).filter(r => !r.error).length;
      if (!bulkTaskSnoozeDate) setNavTaskCount(prev => prev + tasksAdded);
      else setSnoozedTaskCount(prev => prev + tasksAdded);

      setClientAlerts(updatedAlerts);
      setBulkSelected(new Set());
      setBulkMode(false);
      setShowBulkTaskModal(false);
      setBulkTaskNote("");
      setBulkTaskSnoozeDate("");
      setBulkTaskSnoozeTime("07:00");

      if (updatedAlerts.length === 0 && allNoActionResolved()) {
        handlePostClear([], resolvedNoActionFlags);
      }
    } catch (err) {
      setAcceptError(`Bulk task error: ${err.message}`);
    } finally {
      setBulkSubmitting(false);
    }
  };

  const bulkResolveInfo = async () => {
    const alerts = clientNoActionAlerts.filter(a => infoBulkSelected.has(a.fingerprintHash || `${a.flagType}-${a.flagDetail || ""}`));
    if (!alerts.length) return;
    try {
      setInfoBulkSubmitting(true);
      const newResolved = new Set(resolvedNoActionFlags);
      alerts.forEach(a => newResolved.add(a.fingerprintHash || `${a.flagType}-${a.flagDetail || ""}`));
      setResolvedNoActionFlags(newResolved);

      const typesToClear = new Set();
      setClientsWithFlags(prev => prev.map(c => {
        if (c.clientName !== selectedClient?.clientName) return c;
        const updatedCounts = { ...c.alertCounts };
        const updatedFlags = { ...c.flags };
        
        alerts.forEach(na => {
          if (updatedCounts[na.flagType] > 0) updatedCounts[na.flagType]--;
          const remainingOfType = clientNoActionAlerts.filter(n => n.flagType === na.flagType && !newResolved.has(n.fingerprintHash || n.flagType));
          if (remainingOfType.length === 0) {
            updatedFlags[na.flagType] = false;
            typesToClear.add(na.flagType);
          }
        });
        return { ...c, alertCounts: updatedCounts, flags: updatedFlags };
      }));

      if (sessionId && selectedClient) {
        await Promise.all(alerts.map(na => 
          fetch("/api/triage", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "resolve_noaction_flag", sessionId, clientName: selectedClient.clientName, flagType: na.flagType, fingerprintHash: na.fingerprintHash, automationCommanderSheetId }),
          }).catch(() => {})
        ));
        
        if (typesToClear.size > 0) {
          fetch("/api/triage", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "update_session_flags", sessionId, clientName: selectedClient.clientName, clearedFlagKeys: Array.from(typesToClear) }),
          }).catch(() => {});
        }
      }

      const allResolved = clientNoActionAlerts.every(n => newResolved.has(n.fingerprintHash || n.flagType));
      const proactiveDone = proactiveAlerts.filter(a => a.clientName === selectedClient?.clientName).length === 0;
      if (allResolved && proactiveDone && clientAlerts.length === 0) {
        handlePostClear([], newResolved);
      }

      setInfoBulkSelected(new Set());
      setInfoBulkMode(false);
    } catch (err) {
      console.error(err);
    } finally {
      setInfoBulkSubmitting(false);
    }
  };

  const infoBulkCreateTasks = async () => {
    const alerts = clientNoActionAlerts.filter(a => infoBulkSelected.has(a.fingerprintHash || `${a.flagType}-${a.flagDetail || ""}`));
    if (!alerts.length) return;
    try {
      setInfoBulkSubmitting(true);
      setAcceptError("");
      const snoozedUntil = infoBulkTaskSnoozeDate
        ? new Date(`${infoBulkTaskSnoozeDate}T${infoBulkTaskSnoozeTime}:00`).toISOString()
        : null;
      
      let successCount = 0;
      const newResolved = new Set(resolvedNoActionFlags);

      for (const na of alerts) {
        const alertPayload = { ...na, heading: na.flagName, detail: na.flagDetail, summary: { summary: na.flagDetail } };
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "create_task",
            alert: alertPayload,
            taskNote: infoBulkTaskNote,
            automationCommanderSheetId,
            isProactive: false,
          }),
        });
        const data = await res.json();
        if (data.success) {
          successCount++;
          newResolved.add(na.fingerprintHash || `${na.flagType}-${na.flagDetail || ""}`);
          
          if (sessionId && selectedClient) {
            await fetch("/api/triage", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "resolve_noaction_flag", sessionId, clientName: selectedClient.clientName, flagType: na.flagType, fingerprintHash: na.fingerprintHash, automationCommanderSheetId }),
            }).catch(() => {});
          }

          if (infoBulkTaskSnoozeDate && data.fingerprintHash) {
            await fetch("/api/triage", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "snooze_task",
                fingerprintHash: data.fingerprintHash,
                snoozedUntil,
                automationCommanderSheetId,
              }),
            }).catch(() => {});
          }
        }
      }

      if (successCount === 0) {
        setAcceptError("Failed to create tasks for selected alerts");
        return;
      }

      setResolvedNoActionFlags(newResolved);
      const typesToClear = new Set();

      setClientsWithFlags(prev => prev.map(c => {
        if (c.clientName !== selectedClient?.clientName) return c;
        const updatedCounts = { ...c.alertCounts };
        const updatedFlags = { ...c.flags };
        
        alerts.forEach(na => {
          if (updatedCounts[na.flagType] > 0) updatedCounts[na.flagType]--;
          const remainingOfType = clientNoActionAlerts.filter(n => n.flagType === na.flagType && !newResolved.has(n.fingerprintHash || n.flagType));
          if (remainingOfType.length === 0) {
            updatedFlags[na.flagType] = false;
            typesToClear.add(na.flagType);
          }
        });
        return { ...c, alertCounts: updatedCounts, flags: updatedFlags };
      }));

      if (sessionId && selectedClient && typesToClear.size > 0) {
        fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "update_session_flags", sessionId, clientName: selectedClient.clientName, clearedFlagKeys: Array.from(typesToClear) }),
        }).catch(() => {});
      }

      if (!infoBulkTaskSnoozeDate) setNavTaskCount(prev => prev + successCount);
      else setSnoozedTaskCount(prev => prev + successCount);

      const allResolved = clientNoActionAlerts.every(n => newResolved.has(n.fingerprintHash || n.flagType));
      const proactiveDone = proactiveAlerts.filter(a => a.clientName === selectedClient?.clientName).length === 0;
      if (allResolved && proactiveDone && clientAlerts.length === 0) {
        handlePostClear([], newResolved);
      }

      setInfoBulkSelected(new Set());
      setInfoBulkMode(false);
      setShowInfoBulkTaskModal(false);
      setInfoBulkTaskNote("");
      setInfoBulkTaskSnoozeDate("");
      setInfoBulkTaskSnoozeTime("07:00");

    } catch (err) {
      setAcceptError(`Bulk task error: ${err.message}`);
    } finally {
      setInfoBulkSubmitting(false);
    }
  };

  const bulkAcknowledgeProactive = async () => {
    const alerts = proactiveAlerts.filter(a => proactiveBulkSelected.has(a.rowIndex));
    if (!alerts.length) return;
    const alertKeys = alerts.map(a => a.alertKey);
    try {
        setProactiveBulkSubmitting(true);
        const res = await fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "bulk_acknowledge_proactive_alerts", alertKeys, automationCommanderSheetId, sessionId }),
        });
        const data = await res.json();
        if (!data.success) {
          console.error(`❌ bulk_acknowledge_proactive_alerts failed: ${data.error}`);
          return;
        }
        const selectedRowIndexes = new Set(alerts.map(a => a.rowIndex));
        const remaining = proactiveAlerts.filter(a => !selectedRowIndexes.has(a.rowIndex));
        const counts = {};
        remaining.forEach(a => { 
          const cName = a.clientName || a.metadata?.endClientName || a.metadata?.clientName;
          if (cName) counts[cName] = (counts[cName] || 0) + 1; 
        });
        setProactiveCountsByClient(counts);
        setProactiveAlerts(remaining);
        const remainingProactiveCount = remaining.filter(a => a.clientName === selectedClient?.clientName).length;

        setProactiveBulkSelected(new Set());
        setProactiveBulkMode(false);

        const infoDone = clientNoActionAlerts.every(na => resolvedNoActionFlags.has(na.fingerprintHash || `${na.flagType}-${na.flagDetail || ""}`));
        if (clientAlerts.length === 0 && infoDone && remainingProactiveCount === 0) {
          handlePostClear([], resolvedNoActionFlags);
        }
    } catch (err) {
      console.error("Failed to bulk acknowledge:", err);
    } finally {
      setProactiveBulkSubmitting(false);
    }
  };

  const proactiveBulkCreateTasks = async () => {
    const alerts = proactiveAlerts.filter(a => proactiveBulkSelected.has(a.rowIndex));
    if (!alerts.length) return;
    try {
      setProactiveBulkSubmitting(true);
      setAcceptError("");
      const snoozedUntil = proactiveBulkTaskSnoozeDate
        ? new Date(`${proactiveBulkTaskSnoozeDate}T${proactiveBulkTaskSnoozeTime}:00`).toISOString()
        : null;
      
      let successCount = 0;
      const successfulRowIndexes = new Set();
      for (const alert of alerts) {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "create_task",
            alert: alert,
            taskNote: proactiveBulkTaskNote,
            automationCommanderSheetId,
            isProactive: true,
            proactiveAlertKey: alert.alertKey,
          }),
        });
        const data = await res.json();
        if (data.success) {
          successCount++;
          successfulRowIndexes.add(alert.rowIndex);
          
          if (sessionId) {
            await fetch("/api/triage", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "remove_alert", sessionId, alertId: alert.alertKey }),
            }).catch(() => {});
          }

          if (proactiveBulkTaskSnoozeDate && data.fingerprintHash) {
            await fetch("/api/triage", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "snooze_task",
                fingerprintHash: data.fingerprintHash,
                snoozedUntil,
                automationCommanderSheetId,
              }),
            }).catch(() => {});
          }
        }
      }

      if (successCount === 0) {
        setAcceptError("Failed to create tasks for selected alerts");
        return;
      }

      const remaining = proactiveAlerts.filter(a => !successfulRowIndexes.has(a.rowIndex));
      const counts = {};
      remaining.forEach(a => { 
        const cName = a.clientName || a.metadata?.endClientName || a.metadata?.clientName;
        if (cName) counts[cName] = (counts[cName] || 0) + 1; 
      });
      setProactiveCountsByClient(counts);
      setProactiveAlerts(remaining);
      const remainingProactiveCount = remaining.filter(a => a.clientName === selectedClient?.clientName).length;

      if (!proactiveBulkTaskSnoozeDate) setNavTaskCount(prev => prev + successCount);
      else setSnoozedTaskCount(prev => prev + successCount);

      setProactiveBulkSelected(new Set());
      setProactiveBulkMode(false);
      setShowProactiveBulkTaskModal(false);
      setProactiveBulkTaskNote("");
      setProactiveBulkTaskSnoozeDate("");
      setProactiveBulkTaskSnoozeTime("07:00");

      const infoDone = clientNoActionAlerts.every(na => resolvedNoActionFlags.has(na.fingerprintHash || `${na.flagType}-${na.flagDetail || ""}`));
      if (clientAlerts.length === 0 && infoDone && remainingProactiveCount === 0) {
        handlePostClear([], resolvedNoActionFlags);
      }
    } catch (err) {
      setAcceptError(`Bulk task error: ${err.message}`);
    } finally {
      setProactiveBulkSubmitting(false);
    }
  };

  const getActionableDetail = (alert) => {
    const type = alert.flagType || alert.alertType || alert.type || "";
    if (type.startsWith("expense")) {
      const flags = alert.data?.flags || [];
      const isMissing = String(flags[0]||"").trim() === "1";
      if (isMissing) return "Missing Cost";
      const expFlagNames = [null,"Duplicate App ID","Description mismatch","Amount mismatch","VAT mismatch","Rec date mismatch","Pay date mismatch","Status mismatch"];
      const active = flags.map((v,i) => String(v||"").trim()==="1" && expFlagNames[i] ? expFlagNames[i] : null).filter(Boolean);
      return active.length > 0 ? `Mismatch: ${active.join(", ")}` : "";
    }
    if (type.startsWith("invoice")) {
      const flags = alert.data?.flags || [];
      const isMissing = String(flags[0]||"").trim() === "1";
      if (isMissing) return "Missing Invoice";
      const invFlagNames = [null,"Client mismatch","Amount mismatch","Sent date mismatch",null,"Pay date mismatch","Status mismatch"];
      const active = flags.map((v,i) => String(v||"").trim()==="1" && invFlagNames[i] ? invFlagNames[i] : null).filter(Boolean);
      return active.length > 0 ? `Mismatch: ${active.join(", ")}` : "";
    }
    return "";
  };

  const renderAlertContent = (alert) => {
    const alertDates = (alert.firstSeen || alert.lastSeen) ? (
      <div style={{ fontSize: "10px", color: "#aaa", marginTop: "6px" }}>
        {alert.firstSeen ? `First seen: ${alert.firstSeen.split("T")[0]}` : ""}
        {alert.firstSeen && alert.lastSeen ? " · " : ""}
        {alert.lastSeen ? `Last seen: ${alert.lastSeen.split("T")[0]}` : ""}
      </div>
    ) : null;

    const ignoreBanner = alert.previousIgnoreReason ? (
      <div style={{ backgroundColor: "#fef3c7", color: "#92400e", padding: "8px 10px", borderRadius: "6px", fontSize: "11px", marginTop: "8px", border: "1px solid #fde68a", pointerEvents: "auto" }}>
        <strong>⚠ Previously Ignored:</strong> {alert.previousIgnoreReason.ignoreReason || "No reason provided"}
        <div style={{ marginTop: "4px", color: "#b45309" }}>
          <em>Resurfaced: {alert.previousIgnoreReason.changeReason}</em>
        </div>
      </div>
    ) : null;

    const ft = alert.flagType || alert.alertType || "";
    const isAppDiscr = ft === "crmConfAppDiscr" || ft === "crmPipeAppDiscr";
    const isDashDiscr = ft === "crmPipeDashDiscr" || ft === "crmConfDashDiscr";
    
    if (isAppDiscr) {
      const sd = alert.data?.sheetData || [];
      const client = sd[0] || ""; const job = sd[1] || ""; const code = sd[2] || "";
      const rev = sd[3] ? `£${parseFloat(String(sd[3]).replace(/[£$€,\s]/g,""))||0}` : "";
      const start = sd[5] || ""; const end = sd[6] || "";
      const likely = sd[7] || "";
      const isPipeline = ft === "crmPipeAppDiscr";
      const isMismatch = alert.subType === "field_mismatch";
      return (
        <div style={{ pointerEvents: "none" }}>
          <div style={{ fontWeight: "600" }}>{client}{job ? ` — ${job}` : ""}</div>
          {code    && <div style={{ fontSize: "11px", color: "#888", marginTop: "2px" }}>Code: {code}</div>}
          {rev     && <div style={{ fontSize: "11px", color: "#888" }}>Revenue: {rev}</div>}
          {start   && <div style={{ fontSize: "11px", color: "#888" }}>Dates: {start}{end ? ` → ${end}` : ""}</div>}
          {isPipeline && likely && <div style={{ fontSize: "11px", color: "#888" }}>Likelihood: {(parseFloat(likely) * 100).toFixed(0)}%</div>}
          {isMismatch ? (
            <div style={{ fontSize: "11px", color: "#d97706", marginTop: "3px" }}>
              ⚠ Field mismatch: {(alert.mismatchFields || []).join(", ")}
            </div>
          ) : (
            <div style={{ fontSize: "11px", color: "#c62828", marginTop: "3px" }}>
              {isPipeline ? "In Pipeline — not in CRM" : "In Confirmed — not in CRM"}
            </div>
          )}
          {ignoreBanner}
          {alertDates}
        </div>
      );
    }
    
    if (isDashDiscr) {
      const cd = alert.data?.crmData || [];
      const client = cd[0] || ""; const job = cd[1] || ""; const code = cd[2] || "";
      const rev = cd[3] ? `£${parseFloat(String(cd[3]).replace(/[£$€,\s]/g,""))||0}` : "";
      const start = cd[5] || ""; const end = cd[6] || ""; const likely = cd[7] || "";
      const isMismatch = alert.subType === "field_mismatch";
      const isPipeline = ft === "crmPipeDashDiscr";
      const mismatchFields = alert.mismatchFields || [];
      return (
        <div style={{ pointerEvents: "none" }}>
          <div style={{ fontWeight: "600" }}>{client}{job ? ` — ${job}` : ""}</div>
          {code    && <div style={{ fontSize: "11px", color: "#888", marginTop: "2px" }}>Code: {code}</div>}
          {rev     && <div style={{ fontSize: "11px", color: "#888" }}>Revenue: {rev}</div>}
          {start   && <div style={{ fontSize: "11px", color: "#888" }}>Dates: {start}{end ? ` → ${end}` : ""}</div>}
          {isPipeline && likely && <div style={{ fontSize: "11px", color: "#888" }}>Likelihood: {(parseFloat(likely) * 100).toFixed(0)}%</div>}
          {isMismatch ? (
            <div style={{ fontSize: "11px", color: "#d97706", marginTop: "3px" }}>
              ⚠ Field mismatch: {mismatchFields.join(", ")}
            </div>
          ) : (
            <div style={{ fontSize: "11px", color: "#c62828", marginTop: "3px" }}>
              {isPipeline ? "In CRM — not in Pipeline" : "In CRM — not in Confirmed"}
            </div>
          )}
          {ignoreBanner}
          {alertDates}
        </div>
      );
    }
    
    const detailSub = getActionableDetail(alert);
    return (
      <div style={{ pointerEvents: "none" }}>
        <div style={{ fontWeight: "600", color: "#333" }}>{getAlertSummary(alert)}</div>
        {detailSub && <div style={{ fontSize: "11px", fontWeight: "600", color: "#d97706", marginTop: "4px" }}>⚠ {detailSub}</div>}
        {ignoreBanner}
        {alertDates}
      </div>
    );
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>{selectedClient.clientName}</h1>
        <p style={styles.subtitle}>{Object.values(groupedAlerts).reduce((sum, arr) => sum + arr.length, 0) + clientNoActionAlerts.length + clientProactiveAlertsList.length} alert(s)</p>
      </div>

      <div style={styles.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <button className="triage-btn" onClick={() => { setAcceptError(""); setScreen("clientSelection"); }} style={{ ...styles.buttonSecondary, fontSize: "13px" }}>
            ← Back to Clients
          </button>
          {(() => {
            let info = (clientsWithFlags || []).find(c => c.clientName === selectedClient.clientName);
            if (!info?.clientSheetId && !info?.masterSheetId) {
              info = allClientsMap[selectedClient.clientName] || selectedClient;
            }
            if (!info?.clientSheetId && !info?.masterSheetId) return null;
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
        {acceptError && <div style={styles.errorBanner}>{acceptError}</div>}

        {/* Actionable Alerts Section */}
        {Object.keys(groupedAlerts).length > 0 && (
          <div style={{ marginBottom: "32px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", paddingBottom: "8px", borderBottom: "2px solid #e0e0e0" }}>
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#1a1a1a", margin: 0 }}>Actionable alerts</h2>
              {clientAlerts.length > 1 && (
                <button className="triage-btn" onClick={() => { setBulkMode(v => !v); setBulkSelected(new Set()); }}
                  style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px",
                    ...(bulkMode ? { background: "#ede9fe", borderColor: "#7c3aed", color: "#5b21b6" } : {}) }}>
                  {bulkMode ? "✕ Cancel bulk" : "☑ Bulk actions"}
                </button>
              )}
            </div>
            
            <div>
              {Object.keys(groupedAlerts).map((type) => {
                const groupAlerts = groupedAlerts[type];
                const groupKeys   = groupAlerts.map((alert) => alert.fingerprintHash || `${alert.flagType || alert.type}-${alert.sheetName}-${alert.rowNumber}`);
                const allSelected = groupKeys.every(k => bulkSelected.has(k));
                const anySelected = groupKeys.some(k => bulkSelected.has(k));
                return (
                <div key={type} style={{ marginBottom: "20px" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
                    <h3 style={{ fontSize: "14px", fontWeight: "bold", color: "#2196f3", margin: 0 }}>
                      {(() => {
                        const isDash = type === "crmPipeDashDiscr" || type === "crmConfDashDiscr";
                        const isApp  = type === "crmPipeAppDiscr"  || type === "crmConfAppDiscr";
                        const tab    = (type === "crmPipeDashDiscr" || type === "crmPipeAppDiscr") ? "Pipeline" : "Confirmed";
                        const kind   = isDash ? "dashboard" : "app";
                        if (isDash || isApp) {
                          const hasNotFound = groupAlerts.some(a => !a.subType || a.subType === "not_found");
                          const hasMismatch = groupAlerts.some(a => a.subType === "field_mismatch");
                          if (hasMismatch && !hasNotFound) return `CRM ${kind} discrepancy — field mismatch (${tab})`;
                          if (!hasMismatch && hasNotFound) return `CRM ${kind} discrepancy — missing job (${tab})`;
                          if (hasMismatch && hasNotFound)  return `CRM ${kind} discrepancy (${tab})`;
                        }
                        return getFlagName(type);
                      })()}
                    </h3>
                    {bulkMode && groupAlerts.length > 1 && (
                      <button className="triage-btn" onClick={() => {
                        const newSel = new Set(bulkSelected);
                        if (allSelected) { groupKeys.forEach(k => newSel.delete(k)); }
                        else             { groupKeys.forEach(k => newSel.add(k)); }
                        setBulkSelected(newSel);
                      }} style={{ ...styles.buttonSecondary, fontSize: "11px", padding: "3px 8px",
                        ...(anySelected && !allSelected ? { background: "#eef4ff", borderColor: "#93c5fd", color: "#1d4ed8" } : {}) }}>
                        {allSelected ? "Deselect all" : anySelected ? `− Select remaining (${groupKeys.length - groupKeys.filter(k => bulkSelected.has(k)).length})` : "Select all"}
                      </button>
                    )}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {(() => {
                      const isInvoiceType = type === "invoiceDashboardDiscr";
                      if (isInvoiceType) {
                        const drafts = groupAlerts.filter(a => (a.summary?.status || "").toLowerCase() === "draft")
                          .sort((a, b) => parseInt(a.summary?.invoiceNo || 0) - parseInt(b.summary?.invoiceNo || 0));
                        const nonDrafts = groupAlerts.filter(a => (a.summary?.status || "").toLowerCase() !== "draft")
                          .sort((a, b) => parseInt(a.summary?.invoiceNo || 0) - parseInt(b.summary?.invoiceNo || 0));
                        const renderGroup = (alerts, label, globalOffset) => alerts.length === 0 ? null : (
                          <div key={label}>
                            <div style={{ fontSize: "11px", fontWeight: "700", color: "#888", textTransform: "uppercase", letterSpacing: "0.05em", padding: "6px 0 4px" }}>{label}</div>
                            {alerts.map((alert, localIdx) => {
                              const selKey = alert.fingerprintHash || `${alert.flagType || alert.type}-${alert.sheetName}-${alert.rowNumber}`;
                              const isChecked = bulkSelected.has(selKey);

                              return bulkMode ? (
                                <div key={selKey} onClick={() => {
                                    const newSel = new Set(bulkSelected);
                                    if (isChecked) newSel.delete(selKey); else newSel.add(selKey);
                                    setBulkSelected(newSel);
                                  }} style={{ display: "flex", alignItems: "flex-start", gap: "10px", padding: "12px", border: `1px solid ${isChecked ? "#7c3aed" : "#e0e0e0"}`, borderRadius: "4px", cursor: "pointer", backgroundColor: isChecked ? "#ede9fe" : "#fff", fontSize: "13px" }}>
                                  <input type="checkbox" checked={isChecked} onChange={() => {}} style={{ marginTop: "2px", accentColor: "#7c3aed", flexShrink: 0 }} />
                                  <div style={{ flex: 1 }}>{renderAlertContent(alert)}</div>
                                </div>
                              ) : (
                                <button className="triage-btn" key={selKey} onClick={() => selectAlert(alert)}
                                  style={{ ...styles.optionButton, textAlign: "left", padding: "12px", border: "1px solid #e0e0e0", borderRadius: "4px", cursor: "pointer", backgroundColor: "#fff", fontSize: "13px", transition: "all 0.2s" }}
                                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#f5f5f5"; e.currentTarget.style.borderColor = "#2196f3"; }}
                                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "#fff"; e.currentTarget.style.borderColor = "#e0e0e0"; }}>
                                  {renderAlertContent(alert)}
                                </button>
                              );
                            })}
                          </div>
                        );
                        return (
                          <div>
                            {renderGroup(nonDrafts, "Sent / non-draft", 0)}
                            {renderGroup(drafts, "Draft", nonDrafts.length)}
                          </div>
                        );
                      }
                      const isExpenseGroup = type === "expenseDashboardDiscr";
                      const alertBtns = groupAlerts.map((alert, idx) => {
                        const selKey = alert.fingerprintHash || `${alert.flagType || alert.type}-${alert.sheetName}-${alert.rowNumber}`;
                        const isChecked = bulkSelected.has(selKey);

                        return bulkMode ? (
                          <div key={idx} onClick={() => {
                              const newSel = new Set(bulkSelected);
                              if (isChecked) newSel.delete(selKey); else newSel.add(selKey);
                              setBulkSelected(newSel);
                            }} style={{ display: "flex", alignItems: "flex-start", gap: "10px", padding: "12px", border: `1px solid ${isChecked ? "#7c3aed" : "#e0e0e0"}`, borderRadius: "4px", cursor: "pointer", backgroundColor: isChecked ? "#ede9fe" : "#fff", fontSize: "13px" }}>
                            <input type="checkbox" checked={isChecked} onChange={() => {}} style={{ marginTop: "2px", accentColor: "#7c3aed", flexShrink: 0 }} />
                            <div style={{ flex: 1 }}>{renderAlertContent(alert)}</div>
                          </div>
                        ) : (
                          <button className="triage-btn" key={idx} onClick={() => selectAlert(alert)}
                            style={{ ...styles.optionButton, textAlign: "left", padding: "12px", border: "1px solid #e0e0e0", borderRadius: "4px", cursor: "pointer", backgroundColor: "#fff", fontSize: "13px", transition: "all 0.2s" }}
                            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#f5f5f5"; e.currentTarget.style.borderColor = "#2196f3"; }}
                            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "#fff"; e.currentTarget.style.borderColor = "#e0e0e0"; }}>
                            {renderAlertContent(alert)}
                          </button>
                        );
                      });
                      const isInvoiceGroup = type === "invoiceDashboardDiscr";
                      const finalBtns = isExpenseGroup && selectedClient
                        ? [...alertBtns, (
                            <div key="assign-btn-exp" style={{ display: "flex", justifyContent: "flex-start", marginTop: "4px" }}>
                              <button className="triage-btn"
                                onClick={() => setActiveNav("outgoings")}
                                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 14px", color: "#059669", borderColor: "#6ee7b7" }}>
                                📤 Assign Outgoings
                              </button>
                            </div>
                          )]
                        : isInvoiceGroup && selectedClient
                        ? [...alertBtns, (
                            <div key="assign-btn-inv" style={{ display: "flex", justifyContent: "flex-start", marginTop: "4px" }}>
                              <button className="triage-btn"
                                onClick={() => setActiveNav("invoices")}
                                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 14px", color: "#ea580c", borderColor: "#fdba74" }}>
                                📥 Assign Invoices
                              </button>
                            </div>
                          )]
                        : alertBtns;
                      
                      return finalBtns;
                    })()}
                  </div>
                </div>
                );
              })}
            </div>

            {/* Sticky bulk action bar for Actionable */}
            {bulkMode && bulkSelected.size > 0 && (
              <div style={{ position: "sticky", bottom: 0, background: "#fff", borderTop: "2px solid #7c3aed",
                padding: "12px", display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap",
                boxShadow: "0 -2px 8px rgba(0,0,0,0.08)", zIndex: 10, marginTop: "12px" }}>
                <span style={{ fontSize: "13px", color: "#5b21b6", fontWeight: "600", flex: 1 }}>
                  {bulkSelected.size} alert{bulkSelected.size !== 1 ? "s" : ""} selected
                </span>
                <button className="triage-btn" onClick={() => setShowBulkIgnoreModal(true)}
                  style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "6px 12px", color: "#dc2626", borderColor: "#fca5a5" }}>
                  🚫 Ignore selected
                </button>
                <button className="triage-btn" onClick={() => setShowBulkTaskModal(true)}
                  style={{ background: "#7c3aed", color: "white", border: "none", borderRadius: "6px",
                    padding: "6px 12px", fontWeight: "600", fontSize: "12px", cursor: "pointer" }}>
                    📋 Create tasks
                </button>
              </div>
            )}
          </div>
        )}

        {/* Informational Alerts Section */}
        {clientNoActionAlerts.length > 0 && (
          <div style={{ marginBottom: "32px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", paddingBottom: "8px", borderBottom: "2px solid #e0e0e0" }}>
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#1a1a1a", margin: 0 }}>
                Informational alerts
                <span style={{ fontWeight: "400", marginLeft: "8px", fontSize: "13px", color: "#666" }}>
                  ({resolvedNoActionFlags.size}/{clientNoActionAlerts.length} resolved)
                </span>
              </h2>
              {clientNoActionAlerts.length > 1 && (
                <button className="triage-btn" onClick={() => { setInfoBulkMode(m => !m); setInfoBulkSelected(new Set()); }}
                  style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px",
                    ...(infoBulkMode ? { background: "#ede9fe", borderColor: "#7c3aed", color: "#5b21b6" } : {}) }}>
                  {infoBulkMode ? "✕ Cancel bulk" : "☑ Bulk actions"}
                </button>
              )}
            </div>
            
            {infoBulkMode && clientNoActionAlerts.length > 0 && (() => {
              const allKeys = clientNoActionAlerts.map(a => a.fingerprintHash || `${a.flagType}-${a.flagDetail || ""}`);
              const allSelected = allKeys.every(k => infoBulkSelected.has(k));
              return (
                <div style={{ marginBottom: "16px" }}>
                  <button className="triage-btn" onClick={() => {
                    setInfoBulkSelected(allSelected ? new Set() : new Set(allKeys));
                  }} style={{ ...styles.buttonSecondary, fontSize: "11px", padding: "4px 10px" }}>
                    {allSelected ? "Deselect all" : "Select all"}
                  </button>
                </div>
              );
            })()}

            <div>
              {Object.keys(groupedInfoAlerts).map(type => {
                const groupAlerts = groupedInfoAlerts[type];
                return (
                  <div key={type} style={{ marginBottom: "20px" }}>
                    <h3 style={{ fontSize: "14px", fontWeight: "bold", color: "#666", margin: "0 0 10px 0" }}>
                      {getFlagName(type)}
                    </h3>
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                      {groupAlerts.map((na) => {
                        const alertId = na.fingerprintHash || `${na.flagType}-${na.flagDetail || ""}`;
                        const isResolved = resolvedNoActionFlags.has(alertId);
                        const isRichFlag = ["crmCopiedConfChecked", "crmCopiedConfUnchecked", "retainerInvoicesCreated", "retainerInvoicesDeleted", "crmCopiedConfDelete", "invoiceStaleUnsentChanges"].includes(na.flagType);
                        const analysis = noActionAnalysis[alertId] || na.analysisResult;
                        const isLoading = noActionAnalysisLoading[alertId];

                        const handleMarkResolved = () => {
                          const newResolved = new Set([...resolvedNoActionFlags, alertId]);
                          setResolvedNoActionFlags(newResolved);
                          
                          const remainingOfType = clientNoActionAlerts.filter(n => n.flagType === na.flagType && !newResolved.has(n.fingerprintHash || `${n.flagType}-${n.flagDetail || ""}`));
                          const isLastOfType = remainingOfType.length === 0;

                          setClientsWithFlags(prev => prev.map(c => {
                            if (c.clientName !== selectedClient?.clientName) return c;
                            const updatedCounts = { ...c.alertCounts };
                            if (updatedCounts[na.flagType] > 0) updatedCounts[na.flagType]--;
                            const updatedFlags = { ...c.flags };
                            if (isLastOfType) updatedFlags[na.flagType] = false;
                            return { ...c, alertCounts: updatedCounts, flags: updatedFlags };
                          }));

                          if (sessionId && selectedClient) {
                            fetch("/api/triage", {
                              method: "POST", headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ action: "resolve_noaction_flag", sessionId, clientName: selectedClient.clientName, flagType: na.flagType, fingerprintHash: na.fingerprintHash, automationCommanderSheetId }),
                            }).catch(() => {});
                            
                            if (isLastOfType) {
                              fetch("/api/triage", {
                                method: "POST", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ action: "update_session_flags", sessionId, clientName: selectedClient.clientName, clearedFlagKeys: [na.flagType] }),
                              }).catch(() => {});
                            }
                          }
                          
                          if (RICH_NOACTION_FLAG_GROUP[na.flagType] && isLastOfType) {
                            autoClearFlags(clientAlerts, newResolved).catch(() => {});
                          }
                          const allResolved = clientNoActionAlerts.every(n => newResolved.has(n.fingerprintHash || `${n.flagType}-${n.flagDetail || ""}`));
                          const proactiveDone = proactiveAlerts.filter(a => a.clientName === selectedClient?.clientName).length === 0;
                          if (allResolved && proactiveDone && clientAlerts.length === 0) {
                            handlePostClear([], newResolved);
                          }
                        };

                        if (isRichFlag && !isResolved) {
                          const overallOk = analysis?.overallOk;
                          const borderColor = !analysis ? "#e0e0e0" : overallOk ? "#c8e6c9" : "#ffccbc";
                          const bgColor = !analysis ? "#fff" : overallOk ? "#f1f8f2" : "#fff8f6";

                          return (
                            <div key={alertId} style={{ border: `1px solid ${borderColor}`, borderRadius: "6px", background: bgColor, padding: "12px" }}>
                              {infoBulkMode && (
                                <label style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px", cursor: "pointer", fontSize: "12px", fontWeight: "600", color: "#5b21b6" }}>
                                  <input type="checkbox" checked={infoBulkSelected.has(alertId)} onChange={() => {
                                    setInfoBulkSelected(prev => {
                                      const next = new Set(prev);
                                      if (next.has(alertId)) next.delete(alertId); else next.add(alertId);
                                      return next;
                                    });
                                  }} style={{ accentColor: "#7c3aed", cursor: "pointer" }} />
                                  Select for bulk action
                                </label>
                              )}
                              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: analysis ? "10px" : "0", flexWrap: "wrap", gap: "8px" }}>
                                <div style={{ flexShrink: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: "13px", fontWeight: "600", color: "#444" }}>
                                    {na.flagName || getFlagName(na.flagType)}
                                  </div>
                                  {na.flagDetail && (
                                    <div style={{ fontSize: "12px", color: "#666", marginTop: "4px", lineHeight: "1.4" }}>
                                      {na.flagDetail}
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
                                    <button className="triage-btn"
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
                                    <button className="triage-btn"
                                      onClick={() => analyzeNoActionFlag(na)}
                                      style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px" }}
                                    >
                                      🔍 Analyse
                                    </button>
                                  )}
                                  {isLoading && (
                                    <span style={{ fontSize: "12px", color: "#888", padding: "5px 10px", display: "inline-flex", alignItems: "center" }}><Spinner size={12} />Analysing…</span>
                                  )}
                                  {analysis && !isLoading && (
                                    <button className="triage-btn"
                                      onClick={() => analyzeNoActionFlag(na)}
                                      style={{ ...styles.buttonSecondary, fontSize: "11px", padding: "4px 8px" }}
                                    >
                                      ↻ Re-run
                                    </button>
                                  )}
                                  <button className="triage-btn"
                                    onClick={handleMarkResolved}
                                    style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px" }}
                                  >
                                    ✓ Mark resolved
                                  </button>
                                </div>
                              </div>
                              {analysis && !isLoading && (
                                <div>
                                  <div style={{
                                    padding: "6px 10px", borderRadius: "4px", marginBottom: "8px", fontSize: "12px", fontWeight: "600",
                                    background: overallOk ? "#e8f5e9" : "#fbe9e7", color: overallOk ? "#2e7d32" : "#bf360c",
                                  }}>
                                    {overallOk ? "✓ Everything looks correct" : "⚠ Issues found — review below"}
                                  </div>
                                  {(analysis.results || []).map((r, ri) => (
                                    <div key={ri} style={{
                                      marginBottom: "8px", padding: "8px 10px", borderRadius: "4px",
                                      border: `1px solid ${r.status === "ok" ? "#c8e6c9" : r.status === "issue" ? "#ffccbc" : "#e0e0e0"}`,
                                      background: r.status === "ok" ? "#f9fef9" : r.status === "issue" ? "#fff8f6" : "#fafafa",
                                    }}>
                                      {(r.jobName || r.projectCode) && (
                                        <div style={{ fontSize: "12px", fontWeight: "600", color: "#333", marginBottom: "4px" }}>
                                          {r.clientName && <span style={{ fontWeight: "400", color: "#666" }}>{r.clientName} — </span>}
                                          {r.jobName || r.projectCode}
                                          {r.projectCode && r.jobName && <TruncatedCode code={r.projectCode} />}
                                          {r.periodLabel && <span style={{ fontWeight: "400", color: "#666", marginLeft: "6px" }}> — {r.periodLabel}</span>}
                                          {r.parentSheetRow && <span style={{ fontWeight: "400", color: "#aaa", marginLeft: "6px", fontSize: "11px" }}>{r.tab || "Confirmed"} row {r.parentSheetRow}</span>}
                                          {(r.pipelineRow || r.confirmedRow) && (
                                            <span style={{ fontWeight: "400", color: "#aaa", marginLeft: "6px", fontSize: "11px" }}>
                                              {r.pipelineRow ? `Pipeline row ${r.pipelineRow}` : ""}
                                              {r.pipelineRow && r.confirmedRow ? " · " : ""}
                                              {r.confirmedRow ? `Confirmed row ${r.confirmedRow}` : ""}
                                            </span>
                                          )}
                                        </div>
                                      )}
                                      {r.message && (!r.checks || r.checks.length === 0) && (
                                        <div style={{ fontSize: "12px", color: "#666" }}>{r.message}</div>
                                      )}
                                      {(r.checks || []).map((chk, ci) => (
                                        <div key={ci} style={{ fontSize: "12px", color: chk.ok ? "#2e7d32" : "#c62828", marginTop: "2px" }}>
                                          {(() => {
                                            const parts = [];
                                            const re = /\(([^)]{17,})\)/g;
                                            let last = 0, m;
                                            const msg = chk.message || "";
                                            while ((m = re.exec(msg)) !== null) {
                                              if (m.index > last) parts.push(msg.slice(last, m.index));
                                              parts.push(<TruncatedCode key={m.index} code={m[1]} />);
                                              last = m.index + m[0].length;
                                            }
                                            if (last < msg.length) parts.push(msg.slice(last));
                                            return parts.length > 1 ? parts : msg;
                                          })()}
                                        </div>
                                      ))}
                                    </div>
                                  ))}
                                </div>
                              )}
                              {analysis && !analysis.success && (
                                <div style={{ fontSize: "12px", color: "#c62828", marginTop: "6px" }}>Error: {analysis.error}</div>
                              )}
                            </div>
                          );
                        }

                        return (
                          <div key={alertId} style={{
                            display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderRadius: "4px",
                            border: `1px solid ${isResolved ? "#c8e6c9" : "#e0e0e0"}`, background: isResolved ? "#f1f8f2" : "#fff", gap: "12px",
                          }}>
                            {infoBulkMode && (
                              <input type="checkbox" checked={infoBulkSelected.has(alertId)} onChange={() => {
                                setInfoBulkSelected(prev => {
                                  const next = new Set(prev);
                                  if (next.has(alertId)) next.delete(alertId); else next.add(alertId);
                                  return next;
                                });
                              }} style={{ accentColor: "#7c3aed", cursor: "pointer", flexShrink: 0 }} />
                            )}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: "13px", fontWeight: "600", color: isResolved ? "#2e7d32" : "#555", textDecoration: isResolved ? "line-through" : "none" }}>
                                {na.flagName || getFlagName(na.flagType)}
                              </div>
                              {na.flagDetail && (
                                <div style={{ fontSize: "12px", color: isResolved ? "#2e7d32" : "#888", marginTop: "4px", textDecoration: isResolved ? "line-through" : "none", lineHeight: "1.4" }}>
                                  {na.flagDetail}
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
                              <button className="triage-btn"
                                onClick={handleMarkResolved}
                                style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px", whiteSpace: "nowrap", flexShrink: 0 }}
                              >
                                Mark resolved
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Sticky bulk action bar for Info */}
            {infoBulkMode && infoBulkSelected.size > 0 && (
              <div style={{ position: "sticky", bottom: 0, background: "#fff", borderTop: "2px solid #7c3aed",
                padding: "12px", display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap",
                boxShadow: "0 -2px 8px rgba(0,0,0,0.08)", zIndex: 10, marginTop: "12px" }}>
                <span style={{ fontSize: "13px", color: "#5b21b6", fontWeight: "600", flex: 1 }}>
                  {infoBulkSelected.size} alert{infoBulkSelected.size !== 1 ? "s" : ""} selected
                </span>
                <button className="triage-btn" onClick={bulkResolveInfo} disabled={infoBulkSubmitting}
                  style={{ background: "#f5f3ff", color: "#7c3aed", border: "1px solid #c4b5fd", borderRadius: "6px",
                    padding: "6px 12px", fontWeight: "600", fontSize: "12px", cursor: "pointer",
                    opacity: infoBulkSubmitting ? 0.5 : 1 }}>
                  {infoBulkSubmitting ? <><Spinner />Resolving...</> : `✓ Mark resolved (${infoBulkSelected.size})`}
                </button>
                <button className="triage-btn" onClick={() => setShowInfoBulkTaskModal(true)} disabled={infoBulkSubmitting}
                  style={{ background: "#7c3aed", color: "white", border: "none", borderRadius: "6px",
                    padding: "6px 12px", fontWeight: "600", fontSize: "12px", cursor: "pointer",
                    opacity: infoBulkSubmitting ? 0.5 : 1 }}>
                  📋 Create tasks
                </button>
              </div>
            )}
          </div>
        )}

        {/* Info bulk create tasks modal */}
        {showInfoBulkTaskModal && (
          <div style={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setShowInfoBulkTaskModal(false); }}>
            <div style={styles.modalCard}>
              <h3 style={styles.modalTitle}>Create {infoBulkSelected.size} Task{infoBulkSelected.size !== 1 ? "s" : ""}</h3>
              <p style={styles.modalSubtitle}>These informational alerts will be added to your task list for follow-up.</p>
              <textarea value={infoBulkTaskNote} onChange={e => setInfoBulkTaskNote(e.target.value)}
                placeholder="Shared note for all tasks (optional)..." style={styles.modalTextarea} autoFocus />
              <div style={{ marginTop: "12px", borderTop: "1px solid #eee", paddingTop: "12px" }}>
                <div style={{ fontSize: "13px", fontWeight: "600", color: "#444", marginBottom: "8px" }}>Snooze until (optional)</div>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                  <input type="date" value={infoBulkTaskSnoozeDate}
                    min={new Date().toISOString().split("T")[0]}
                    onChange={e => setInfoBulkTaskSnoozeDate(e.target.value)}
                    style={{ fontSize: "13px", padding: "6px 8px", border: "1px solid #ddd", borderRadius: "4px" }} />
                  {infoBulkTaskSnoozeDate && (
                    <>
                      <input type="time" value={infoBulkTaskSnoozeTime}
                        onChange={e => setInfoBulkTaskSnoozeTime(e.target.value)}
                        style={{ fontSize: "13px", padding: "6px 8px", border: "1px solid #ddd", borderRadius: "4px", width: "100px" }} />
                      <button className="triage-btn" onClick={() => { setInfoBulkTaskSnoozeDate(""); setInfoBulkTaskSnoozeTime("07:00"); }}
                        style={{ fontSize: "12px", padding: "5px 8px", color: "#888", borderColor: "#ddd" }}>✕ Clear</button>
                    </>
                  )}
                </div>
                {infoBulkTaskSnoozeDate && (
                  <div style={{ fontSize: "12px", color: "#d97706", marginTop: "6px" }}>
                    Tasks will be snoozed until {new Date(`${infoBulkTaskSnoozeDate}T${infoBulkTaskSnoozeTime}:00`).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.
                  </div>
                )}
              </div>
              <div style={styles.modalButtons}>
                <button className="triage-btn" onClick={() => setShowInfoBulkTaskModal(false)} style={styles.buttonSecondary}>Cancel</button>
                <button className="triage-btn" onClick={infoBulkCreateTasks} disabled={infoBulkSubmitting}
                  style={{ background: infoBulkTaskSnoozeDate ? "#d97706" : "#7c3aed", color: "white", border: "none",
                    borderRadius: "6px", padding: "9px 18px", fontWeight: "600", fontSize: "13px",
                    cursor: "pointer", opacity: infoBulkSubmitting ? 0.5 : 1 }}>
                  {infoBulkSubmitting ? <><Spinner />Creating...</> : infoBulkTaskSnoozeDate
                    ? `📋 Create & Snooze ${infoBulkSelected.size} task${infoBulkSelected.size !== 1 ? "s" : ""}`
                    : `📋 Create ${infoBulkSelected.size} task${infoBulkSelected.size !== 1 ? "s" : ""}`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Proactive Alerts Section */}
        {clientProactiveAlertsList.length > 0 && (
          <div style={{ marginBottom: "32px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", paddingBottom: "8px", borderBottom: "2px solid #e0e0e0" }}>
              <h2 style={{ fontSize: "18px", fontWeight: "700", color: "#1a1a1a", margin: 0 }}>
                Proactive alerts
                <span style={{ fontWeight: "400", marginLeft: "8px", fontSize: "13px", color: "#666" }}>
                  ({clientProactiveAlertsList.length})
                </span>
              </h2>
              {clientProactiveAlertsList.length > 1 && (
                <button className="triage-btn" onClick={() => { setProactiveBulkMode(m => !m); setProactiveBulkSelected(new Set()); }}
                  style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "5px 10px",
                    ...(proactiveBulkMode ? { background: "#ede9fe", borderColor: "#7c3aed", color: "#5b21b6" } : {}) }}>
                  {proactiveBulkMode ? "✕ Cancel bulk" : "☑ Bulk actions"}
                </button>
              )}
            </div>
            
            {proactiveBulkMode && clientProactiveAlertsList.length > 0 && (() => {
              const allKeys = clientProactiveAlertsList.map(a => a.rowIndex);
              const allSelected = allKeys.every(k => proactiveBulkSelected.has(k));
              return (
                <div style={{ marginBottom: "16px" }}>
                  <button className="triage-btn" onClick={() => {
                    setProactiveBulkSelected(allSelected ? new Set() : new Set(allKeys));
                  }} style={{ ...styles.buttonSecondary, fontSize: "11px", padding: "4px 10px" }}>
                    {allSelected ? "Deselect all" : "Select all"}
                  </button>
                </div>
              );
            })()}

            <div>
              {Object.keys(groupedProactiveAlerts).map(type => {
                const groupAlerts = groupedProactiveAlerts[type];
                return (
                  <div key={type} style={{ marginBottom: "20px" }}>
                    <h3 style={{ fontSize: "14px", fontWeight: "bold", color: "#d97706", margin: "0 0 10px 0" }}>
                      {PROACTIVE_TYPE_LABELS[type] || type || "Proactive Alert"}
                    </h3>
                    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                      {groupAlerts.map((alert, idx) => {
                        const m = alert.metadata || {};
                        const isBulkSelected = proactiveBulkSelected.has(alert.rowIndex);
                        return (
                          <div key={idx} style={{ border: `1px solid ${proactiveBulkMode && isBulkSelected ? "#7c3aed" : "#ddd"}`, borderRadius: "6px", padding: "14px", backgroundColor: proactiveBulkMode && isBulkSelected ? "#ede9fe" : "#fafafa" }}>
                            {proactiveBulkMode && (
                              <label style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px", cursor: "pointer", fontSize: "12px", fontWeight: "600", color: "#5b21b6" }}>
                                <input type="checkbox" checked={isBulkSelected} onChange={() => {
                                  setProactiveBulkSelected(prev => {
                                    const next = new Set(prev);
                                    if (isBulkSelected) next.delete(alert.rowIndex); else next.add(alert.rowIndex);
                                    return next;
                                  });
                                }} style={{ accentColor: "#7c3aed", cursor: "pointer" }} />
                                Select for bulk action
                              </label>
                            )}
                            <div style={{ fontWeight: "600", fontSize: "14px", color: "#1a1a1a", marginBottom: "6px" }}>
                              {alert.heading}
                            </div>
                            <div style={{ fontSize: "13px", color: "#444", lineHeight: "1.6", marginBottom: "8px" }}>
                              {alert.alertType === "revenue_mismatch" || alert.alertType === "direct_costs_mismatch" || alert.alertType === "pipeline_confirmed_overlap" || alert.alertType === "retainer_shrink_blocked" || alert.alertType === "uninvoiced_new_job" || alert.alertType === "uninvoiced_revenue" ? null : alert.detail}
                            </div>

                            {alert.alertType === "retainer_invoice" && (
                              <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                                {m.endClientName && <div><strong>End client:</strong> {m.endClientName}</div>}
                                {m.jobName && <div><strong>Job:</strong> {m.jobName}</div>}
                                {m.confirmedRow && <div><strong>Confirmed tab row:</strong> {m.confirmedRow}</div>}
                                {m.revenue && <div><strong>Monthly revenue:</strong> {m.revenue}</div>}
                                {m.startDate && <div><strong>Contract period:</strong> {m.startDate} → {m.endDate}</div>}
                                {m.frequencyDays && <div><strong>Invoice frequency:</strong> {freqLabel(m.frequencyDays)} (every ~{m.frequencyDays} days)</div>}
                                {m.lastInvoiceDate && <div><strong>Last invoice sent:</strong> {m.lastInvoiceDate}</div>}
                                {m.expectedByDate && <div><strong>Next expected by:</strong> {m.expectedByDate}</div>}
                                {m.possibleMatchInvoiceNo && (
                                  <div style={{ marginTop: "8px", paddingTop: "8px", borderTop: "1px solid #bae6fd" }}>
                                    {m.possibleMatchCase === "changed" && (
                                      <div style={{ display: "inline-block", padding: "1px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "700", marginBottom: "6px", background: m.possibleMatchConfidence === "high" ? "#fee2e2" : "#fef9c3", color: m.possibleMatchConfidence === "high" ? "#991b1b" : "#713f12", border: `1px solid ${m.possibleMatchConfidence === "high" ? "#fca5a5" : "#fde047"}` }}>
                                        Possible retainer change — {m.possibleMatchConfidence === "high" ? "high" : "medium"} confidence
                                      </div>
                                    )}
                                    {m.possibleMatchCase === "draft" && (
                                      <div style={{ display: "inline-block", padding: "1px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "700", marginBottom: "6px", background: "#e0f2fe", color: "#075985", border: "1px solid #7dd3fc" }}>
                                        Draft invoice found nearby
                                      </div>
                                    )}
                                    <div><strong>{m.possibleMatchCase === "draft" ? "DRAFT invoice found:" : "Invoice found:"}</strong> #{m.possibleMatchInvoiceNo} for £{parseFloat(m.possibleMatchAmount || 0).toFixed(2)}, sent {m.possibleMatchSentDate}</div>
                                    <div>{m.possibleMatchConfirmedRow ? <>Already attached to Confirmed row {m.possibleMatchConfirmedRow}</> : <>Not yet attached to any job in the Confirmed tab</>}</div>
                                    {m.possibleMatchCase === "changed" && <div style={{ marginTop: "4px" }}>This may mean the retainer value has changed.</div>}
                                    {m.possibleMatchCase === "matches" && <div style={{ marginTop: "4px" }}>Matches the expected retainer amount.</div>}
                                    {m.possibleMatchCase === "draft" && <div style={{ marginTop: "4px" }}>It likely just needs sending.</div>}
                                  </div>
                                )}
                                {m.confirmedRow && m.jobName && (!m.possibleMatchInvoiceNo || m.possibleMatchCase === "changed") && (
                                  <div style={{ marginTop: "10px", paddingTop: "10px", borderTop: "1px solid #bae6fd", display: "flex", gap: "8px", flexWrap: "wrap" }}>
                                    {m.possibleMatchInvoiceNo ? (
                                      <>
                                        <button className="triage-btn" onClick={() => {
                                          const clientInfo = (clientsWithFlags || []).find(c => c.clientName === alert.clientName) || allClientsMap[alert.clientName];
                                          setRetainerAlertResolution({ resolutionType: "changeAmount", alertMeta: m, alertKey: alert.alertKey, clientSheetId: clientInfo?.clientSheetId, masterSheetId: clientInfo?.masterSheetId });
                                        }} style={{ padding: "6px 12px", background: "#7c3aed", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>Change retainer amount</button>
                                        <button className="triage-btn" onClick={() => {
                                          const clientInfo = (clientsWithFlags || []).find(c => c.clientName === alert.clientName) || allClientsMap[alert.clientName];
                                          setRetainerSplitInvoice({ alertMeta: m, alertKey: alert.alertKey, clientSheetId: clientInfo?.clientSheetId, masterSheetId: clientInfo?.masterSheetId });
                                        }} style={{ padding: "6px 12px", background: "#0891b2", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>Split invoice</button>
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
                              <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                                {m.endClientName && <div><strong>End client:</strong> {m.endClientName}</div>}
                                {m.jobName && <div><strong>Job:</strong> {m.jobName}{m.projectCode ? ` [${m.projectCode}]` : ""}</div>}
                                {m.confirmedRow && <div><strong>Confirmed tab row:</strong> {m.confirmedRow}</div>}
                                {m.startDate && <div><strong>Job started:</strong> {m.startDate}</div>}
                                {m.revenue && <div><strong>Revenue:</strong> £{parseFloat(m.revenue).toFixed(2)}</div>}
                                <div style={{ marginTop: "6px", fontWeight: "700", color: "#991b1b" }}>Over a month elapsed with zero real invoices sent.</div>
                              </div>
                            )}

                            {alert.alertType === "uninvoiced_revenue" && (
                              <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#fef2f2", border: "1px solid #fecaca", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                                {m.endClientName && <div><strong>End client:</strong> {m.endClientName}</div>}
                                {m.jobName && <div><strong>Job:</strong> {m.jobName}{m.projectCode ? ` [${m.projectCode}]` : ""}</div>}
                                {m.confirmedRow && <div><strong>Confirmed tab row:</strong> {m.confirmedRow}</div>}
                                {m.endDate && <div><strong>Job ended:</strong> {m.endDate}</div>}
                                {m.revenue && <div><strong>Revenue:</strong> £{parseFloat(m.revenue).toFixed(2)}</div>}
                                {m.uninvoicedAmount && <div style={{ marginTop: "6px", fontWeight: "700", color: "#991b1b" }}>£{parseFloat(m.uninvoicedAmount).toFixed(2)} uninvoiced (placeholders and drafts excluded)</div>}
                                {m.draftCount && parseInt(m.draftCount) > 0 && <div style={{ marginTop: "6px", padding: "6px 8px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "4px", color: "#78350f" }}>{m.draftCount} invoice{parseInt(m.draftCount) > 1 ? "s" : ""} totalling £{parseFloat(m.draftTotal || 0).toFixed(2)} {parseInt(m.draftCount) > 1 ? "have" : "has"} a reference but {parseInt(m.draftCount) > 1 ? "are" : "is"} still <strong>Draft</strong> (not yet sent) — not counted as invoiced above.</div>}
                              </div>
                            )}

                            {alert.alertType === "crm_wipe" && (
                              <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#fff7ed", border: "1px solid #fed7aa", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                                {m.timestamp && <div><strong>Log timestamp:</strong> {m.timestamp}</div>}
                                {m.sequenceType && <div><strong>Sequence:</strong> {m.sequenceType}</div>}
                                {m.summary && <div><strong>Summary:</strong> {m.summary}</div>}
                                {m.jobInfo && <div><strong>Job:</strong> {m.jobInfo}</div>}
                                {m.detailsSnippet && <div style={{ marginTop: "4px" }}><strong>AutoLog details:</strong><div style={{ fontFamily: "monospace", fontSize: "11px", color: "#666", marginTop: "2px", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.detailsSnippet}</div></div>}
                              </div>
                            )}

                            {alert.alertType === "revenue_mismatch" && (
                              <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#fef3c7", border: "1px solid #fcd34d", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                                {(() => {
                                  const detail = alert.detail || "";
                                  const mismatchIdx = detail.indexOf("Mismatched rows:");
                                  if (mismatchIdx === -1) return <div style={{ fontWeight: "600" }}>{detail}</div>;
                                  const header = detail.slice(0, mismatchIdx).trim();
                                  const rowsPart = detail.slice(mismatchIdx + "Mismatched rows:".length).trim();
                                  const rows = rowsPart.split(";").map(s => s.trim()).filter(Boolean);
                                  return (
                                    <>
                                      <div style={{ fontWeight: "600", marginBottom: "6px" }}>{header}</div>
                                      <div style={{ fontWeight: "600", marginBottom: "4px" }}>Mismatched rows:</div>
                                      {rows.map((row, i) => {
                                        const diffIdx = row.indexOf("— diff");
                                        if (diffIdx === -1) return <div key={i} style={{ paddingLeft: "8px", marginBottom: "2px" }}>• {row}</div>;
                                        return <div key={i} style={{ paddingLeft: "8px", marginBottom: "2px" }}>• {row.slice(0, diffIdx)}<strong>{row.slice(diffIdx)}</strong></div>;
                                      })}
                                    </>
                                  );
                                })()}
                              </div>
                            )}

                            {alert.alertType === "direct_costs_mismatch" && (
                              <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#fce7f3", border: "1px solid #f9a8d4", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                                {alert.metadata?.tab && <span style={{ display: "inline-block", marginBottom: "6px", padding: "2px 8px", borderRadius: "4px", fontSize: "11px", fontWeight: "700", background: alert.metadata.tab === "Pipeline" ? "#fef3c7" : "#dbeafe", color: alert.metadata.tab === "Pipeline" ? "#92400e" : "#1e40af", border: `1px solid ${alert.metadata.tab === "Pipeline" ? "#fcd34d" : "#93c5fd"}` }}>{alert.metadata.tab} tab</span>}
                                {(() => {
                                  const detail = alert.detail || "";
                                  const mismatchIdx = detail.indexOf("Mismatched rows:");
                                  if (mismatchIdx === -1) return <div style={{ fontWeight: "600" }}>{detail}</div>;
                                  const header = detail.slice(0, mismatchIdx).trim();
                                  const rowsPart = detail.slice(mismatchIdx + "Mismatched rows:".length).trim();
                                  const rows = rowsPart.split(";").map(s => s.trim()).filter(Boolean);
                                  return (
                                    <>
                                      <div style={{ fontWeight: "600", marginBottom: "6px" }}>{header}</div>
                                      <div style={{ fontWeight: "600", marginBottom: "4px" }}>Mismatched rows:</div>
                                      {rows.map((row, i) => {
                                        const diffIdx = row.indexOf("— diff");
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
                                <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#f0fdf4", border: "1px solid #86efac", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                                  <div style={{ fontWeight: "600", marginBottom: "6px" }}>Job exists in both tabs but Pipeline is not closed out</div>
                                  <div style={{ marginBottom: "4px" }}><strong>Confirmed tab</strong></div>
                                  {md.confirmedRow  && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Row: {md.confirmedRow}</div>}
                                  {md.endClientName && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Client: {md.endClientName}</div>}
                                  {md.jobName       && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Job: {md.jobName}</div>}
                                  {md.projectCode   && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Project code: {md.projectCode}</div>}
                                  {md.jobType       && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Job type: {md.jobType}</div>}
                                  <div style={{ marginBottom: "4px", marginTop: "6px" }}><strong>Pipeline tab</strong></div>
                                  {md.pipelineRow   && <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Row: {md.pipelineRow}</div>}
                                  <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>Likelihood: <strong>{md.likelihood ? (parseFloat(md.likelihood) * 100).toFixed(0) + "%" : "(blank)"}</strong></div>
                                  <div style={{ paddingLeft: "8px", marginBottom: "2px" }}>&quot;Copied to confirmed?&quot;: <strong>{md.copiedToConf || "(blank)"}</strong></div>
                                  <div style={{ marginTop: "6px", color: "#166534", fontStyle: "italic" }}>Expected fix: set Pipeline likelihood to 0% or mark &quot;Copied to confirmed?&quot; as Yes.</div>
                                  {md.pipelineRow && (
                                    <div style={{ marginTop: "10px", paddingTop: "10px", borderTop: "1px solid #86efac" }}>
                                      <button className="triage-btn" onClick={() => markPipelineCopied(alert)} style={{ padding: "6px 14px", background: "#16a34a", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>✓ Mark &quot;Copied to confirmed?&quot; = Yes</button>
                                    </div>
                                  )}
                                </div>
                              );
                            })()}

                            {alert.alertType === "retainer_shrink_blocked" && (() => {
                              const md = alert.metadata || {};
                              return (
                                <div style={{ fontSize: "12px", color: "#555", backgroundColor: "#fff7ed", border: "1px solid #fed7aa", borderRadius: "4px", padding: "8px 10px", marginBottom: "8px" }}>
                                  <div style={{ fontWeight: "600", marginBottom: "6px" }}>Retainer contract shrunk — excess child row could not be removed automatically</div>
                                  {md.clientJobStr && <div style={{ marginBottom: "2px" }}><strong>Job:</strong> {md.clientJobStr}</div>}
                                  {md.childRowNum  && <div style={{ marginBottom: "2px" }}><strong>Blocked child row:</strong> {md.childRowNum}</div>}
                                  {md.timestamp    && <div style={{ marginBottom: "6px" }}><strong>First detected:</strong> {String(md.timestamp).slice(0, 10)}</div>}
                                  <div style={{ color: "#92400e", fontStyle: "italic" }}>Row {md.childRowNum} falls outside the new contract period but contains actuals (invoices or expenses) so cannot be auto-removed. Manual review required.</div>
                                </div>
                              );
                            })()}

                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                              <div style={{ fontSize: "11px", color: "#aaa" }}>First seen: {alert.firstSeen} · Last seen: {alert.lastSeen}</div>
                              <div style={{ display: "flex", gap: "8px" }}>
                                {(() => {
                                  const clientInfo = (clientsWithFlags || []).find(c => c.clientName === selectedClient.clientName) || allClientsMap[selectedClient.clientName] || selectedClient;
                                  return (
                                    <>
                                      {(clientInfo?.clientSheetId || clientInfo?.masterSheetId) && (
                                        <button className="triage-btn" onClick={() => {
                                          if (clientInfo.clientSheetId) window.open(`https://docs.google.com/spreadsheets/d/${clientInfo.clientSheetId}/edit`, "_blank");
                                          if (clientInfo.masterSheetId) window.open(`https://docs.google.com/spreadsheets/d/${clientInfo.masterSheetId}/edit`, "_blank");
                                        }} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#1d4ed8", borderColor: "#93c5fd" }}>📊 Open Sheets</button>
                                      )}
                                      {alert.alertType === "expenseDashboardDiscr" && clientInfo && (
                                        <button className="triage-btn" onClick={() => setActiveNav("outgoings")} style={{ ...styles.buttonSecondary, fontSize: "12px", padding: "4px 12px", color: "#059669", borderColor: "#6ee7b7" }}>📤 Assign Outgoings</button>
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
            </div>

            {/* Sticky bulk action bar for Proactive */}
            {proactiveBulkMode && proactiveBulkSelected.size > 0 && (
              <div style={{ position: "sticky", bottom: 0, background: "#fff", borderTop: "2px solid #7c3aed",
                padding: "12px", display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap",
                boxShadow: "0 -2px 8px rgba(0,0,0,0.08)", zIndex: 10, marginTop: "12px" }}>
                <span style={{ fontSize: "13px", color: "#5b21b6", fontWeight: "600", flex: 1 }}>
                  {proactiveBulkSelected.size} alert{proactiveBulkSelected.size !== 1 ? "s" : ""} selected
                </span>
                <button className="triage-btn" onClick={bulkAcknowledgeProactive} disabled={proactiveBulkSubmitting}
                  style={{ background: "#f5f3ff", color: "#7c3aed", border: "1px solid #c4b5fd", borderRadius: "6px",
                    padding: "6px 12px", fontWeight: "600", fontSize: "12px", cursor: "pointer",
                    opacity: proactiveBulkSubmitting ? 0.5 : 1 }}>
                  {proactiveBulkSubmitting ? <><Spinner />Acknowledging...</> : `✓ Acknowledge ${proactiveBulkSelected.size} alert${proactiveBulkSelected.size !== 1 ? "s" : ""}`}
                </button>
                <button className="triage-btn" onClick={() => setShowProactiveBulkTaskModal(true)} disabled={proactiveBulkSubmitting}
                  style={{ background: "#7c3aed", color: "white", border: "none", borderRadius: "6px",
                    padding: "6px 12px", fontWeight: "600", fontSize: "12px", cursor: "pointer",
                    opacity: proactiveBulkSubmitting ? 0.5 : 1 }}>
                  📋 Create tasks
                </button>
              </div>
            )}
          </div>
        )}

        {/* Proactive bulk create tasks modal */}
        {showProactiveBulkTaskModal && (
          <div style={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setShowProactiveBulkTaskModal(false); }}>
            <div style={styles.modalCard}>
              <h3 style={styles.modalTitle}>Create {proactiveBulkSelected.size} Task{proactiveBulkSelected.size !== 1 ? "s" : ""}</h3>
              <p style={styles.modalSubtitle}>These proactive alerts will be added to your task list for follow-up.</p>
              <textarea value={proactiveBulkTaskNote} onChange={e => setProactiveBulkTaskNote(e.target.value)}
                placeholder="Shared note for all tasks (optional)..." style={styles.modalTextarea} autoFocus />
              <div style={{ marginTop: "12px", borderTop: "1px solid #eee", paddingTop: "12px" }}>
                <div style={{ fontSize: "13px", fontWeight: "600", color: "#444", marginBottom: "8px" }}>Snooze until (optional)</div>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                  <input type="date" value={proactiveBulkTaskSnoozeDate}
                    min={new Date().toISOString().split("T")[0]}
                    onChange={e => setProactiveBulkTaskSnoozeDate(e.target.value)}
                    style={{ fontSize: "13px", padding: "6px 8px", border: "1px solid #ddd", borderRadius: "4px" }} />
                  {proactiveBulkTaskSnoozeDate && (
                    <>
                      <input type="time" value={proactiveBulkTaskSnoozeTime}
                        onChange={e => setProactiveBulkTaskSnoozeTime(e.target.value)}
                        style={{ fontSize: "13px", padding: "6px 8px", border: "1px solid #ddd", borderRadius: "4px", width: "100px" }} />
                      <button className="triage-btn" onClick={() => { setProactiveBulkTaskSnoozeDate(""); setProactiveBulkTaskSnoozeTime("07:00"); }}
                        style={{ fontSize: "12px", padding: "5px 8px", color: "#888", borderColor: "#ddd" }}>✕ Clear</button>
                    </>
                  )}
                </div>
                {proactiveBulkTaskSnoozeDate && (
                  <div style={{ fontSize: "12px", color: "#d97706", marginTop: "6px" }}>
                    Tasks will be snoozed until {new Date(`${proactiveBulkTaskSnoozeDate}T${proactiveBulkTaskSnoozeTime}:00`).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.
                  </div>
                )}
              </div>
              <div style={styles.modalButtons}>
                <button className="triage-btn" onClick={() => setShowProactiveBulkTaskModal(false)} style={styles.buttonSecondary}>Cancel</button>
                <button className="triage-btn" onClick={proactiveBulkCreateTasks} disabled={proactiveBulkSubmitting}
                  style={{ background: proactiveBulkTaskSnoozeDate ? "#d97706" : "#7c3aed", color: "white", border: "none",
                    borderRadius: "6px", padding: "9px 18px", fontWeight: "600", fontSize: "13px",
                    cursor: "pointer", opacity: proactiveBulkSubmitting ? 0.5 : 1 }}>
                  {proactiveBulkSubmitting ? <><Spinner />Creating...</> : proactiveBulkTaskSnoozeDate
                    ? `📋 Create & Snooze ${proactiveBulkSelected.size} task${proactiveBulkSelected.size !== 1 ? "s" : ""}`
                    : `📋 Create ${proactiveBulkSelected.size} task${proactiveBulkSelected.size !== 1 ? "s" : ""}`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Bulk ignore modal */}
        {showBulkIgnoreModal && (
          <div style={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setShowBulkIgnoreModal(false); }}>
            <div style={styles.modalCard}>
              <h3 style={styles.modalTitle}>Ignore {bulkSelected.size} Alert{bulkSelected.size !== 1 ? "s" : ""}</h3>
              <p style={styles.modalSubtitle}>These alerts will be marked as ignored and removed from future triage runs.</p>
              <textarea value={bulkIgnoreReason} onChange={e => setBulkIgnoreReason(e.target.value)}
                placeholder="Reason for ignoring (optional)..." style={styles.modalTextarea} autoFocus />
              <div style={styles.modalButtons}>
                <button className="triage-btn" onClick={() => setShowBulkIgnoreModal(false)} style={styles.buttonSecondary}>Cancel</button>
                <button className="triage-btn" onClick={bulkIgnore} disabled={bulkSubmitting}
                  style={{ background: "#dc2626", color: "white", border: "none", borderRadius: "6px",
                    padding: "9px 18px", fontWeight: "600", fontSize: "13px", cursor: "pointer",
                    opacity: bulkSubmitting ? 0.5 : 1 }}>
                  {bulkSubmitting ? <><Spinner />Ignoring...</> : `🚫 Ignore ${bulkSelected.size} alert${bulkSelected.size !== 1 ? "s" : ""}`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Bulk create tasks modal */}
        {showBulkTaskModal && (
          <div style={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setShowBulkTaskModal(false); }}>
            <div style={styles.modalCard}>
              <h3 style={styles.modalTitle}>Create {bulkSelected.size} Task{bulkSelected.size !== 1 ? "s" : ""}</h3>
              <p style={styles.modalSubtitle}>These alerts will be added to your task list for follow-up.</p>
              <textarea value={bulkTaskNote} onChange={e => setBulkTaskNote(e.target.value)}
                placeholder="Shared note for all tasks (optional)..." style={styles.modalTextarea} autoFocus />
              <div style={{ marginTop: "12px", borderTop: "1px solid #eee", paddingTop: "12px" }}>
                <div style={{ fontSize: "13px", fontWeight: "600", color: "#444", marginBottom: "8px" }}>Snooze until (optional)</div>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                  <input type="date" value={bulkTaskSnoozeDate}
                    min={new Date().toISOString().split("T")[0]}
                    onChange={e => setBulkTaskSnoozeDate(e.target.value)}
                    style={{ fontSize: "13px", padding: "6px 8px", border: "1px solid #ddd", borderRadius: "4px" }} />
                  {bulkTaskSnoozeDate && (
                    <>
                      <input type="time" value={bulkTaskSnoozeTime}
                        onChange={e => setBulkTaskSnoozeTime(e.target.value)}
                        style={{ fontSize: "13px", padding: "6px 8px", border: "1px solid #ddd", borderRadius: "4px", width: "100px" }} />
                      <button className="triage-btn" onClick={() => { setBulkTaskSnoozeDate(""); setBulkTaskSnoozeTime("07:00"); }}
                        style={{ fontSize: "12px", padding: "5px 8px", color: "#888", borderColor: "#ddd" }}>✕ Clear</button>
                    </>
                  )}
                </div>
                {bulkTaskSnoozeDate && (
                  <div style={{ fontSize: "12px", color: "#d97706", marginTop: "6px" }}>
                    Tasks will be snoozed until {new Date(`${bulkTaskSnoozeDate}T${bulkTaskSnoozeTime}:00`).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}.
                  </div>
                )}
              </div>
              <div style={styles.modalButtons}>
                <button className="triage-btn" onClick={() => setShowBulkTaskModal(false)} style={styles.buttonSecondary}>Cancel</button>
                <button className="triage-btn" onClick={bulkCreateTasks} disabled={bulkSubmitting}
                  style={{ background: bulkTaskSnoozeDate ? "#d97706" : "#7c3aed", color: "white", border: "none",
                    borderRadius: "6px", padding: "9px 18px", fontWeight: "600", fontSize: "13px",
                    cursor: "pointer", opacity: bulkSubmitting ? 0.5 : 1 }}>
                  {bulkSubmitting ? <><Spinner />Creating...</> : bulkTaskSnoozeDate
                    ? `📋 Create & Snooze ${bulkSelected.size} task${bulkSelected.size !== 1 ? "s" : ""}`
                    : `📋 Create ${bulkSelected.size} task${bulkSelected.size !== 1 ? "s" : ""}`}
                </button>
              </div>
            </div>
          </div>
        )}

      </div>

      {retainerAlertResolution && (
        <RetainerAlertResolutionModal
          resolutionType={retainerAlertResolution.resolutionType}
          alertMeta={retainerAlertResolution.alertMeta}
          alertKey={retainerAlertResolution.alertKey}
          automationCommanderSheetId={automationCommanderSheetId}
          clientSheetId={retainerAlertResolution.clientSheetId}
          masterSheetId={retainerAlertResolution.masterSheetId}
          onClose={() => setRetainerAlertResolution(null)}
          onResolved={() => loadProactiveAlerts()}
        />
      )}
      {retainerSplitInvoice && (
        <RetainerSplitInvoiceModal
          alertMeta={retainerSplitInvoice.alertMeta}
          alertKey={retainerSplitInvoice.alertKey}
          automationCommanderSheetId={automationCommanderSheetId}
          clientSheetId={retainerSplitInvoice.clientSheetId}
          masterSheetId={retainerSplitInvoice.masterSheetId}
          onClose={() => setRetainerSplitInvoice(null)}
          onResolved={() => loadProactiveAlerts()}
        />
      )}
    </div>
  );
}