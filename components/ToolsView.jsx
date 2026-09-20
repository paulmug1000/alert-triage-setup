import React, { useState, useEffect, useMemo, useCallback } from "react";
import Spinner from "./Spinner";
import { useEoM } from "../hooks/useEoM";
import { useTools } from "../hooks/useTools";
import { eomWorkMonthToTargetMonth } from "../utils/helpers";
import { useAppGlobals } from "../hooks/useAppGlobals";
import { useTriage } from "../contexts/TriageContext";

export default function ToolsView({
  allOutgoingsClients,
  allClientsLoaded,
  styles
}) {
  const { automationCommanderSheetId } = useAppGlobals();
  const { sessionId, computeAlertCheckCount, isLoading, startTriage } = useTriage();

  const [eomSubView, setEomSubView] = useState("overview"); // "overview" | "payroll"

  const {
    eomMonthKey, setEomMonthKey, eomAllTasks, setEomAllTasks, eomStatusOverrides, setEomStatusOverrides,
    eomStatusLoading, setEomStatusLoading, eomStatusError, setEomStatusError, eomDetailClient, setEomDetailClient,
    eomClientTasksLoading, setEomClientTasksLoading, eomClientTasksError, setEomClientTasksError, eomTemplates, setEomTemplates,
    eomTemplatesError, setEomTemplatesError, eomAddTaskMode, setEomAddTaskMode, eomNewTaskTemplateId, setEomNewTaskTemplateId,
    eomNewTaskName, setEomNewTaskName, eomNewTaskNotes, setEomNewTaskNotes, eomAddTaskSaving, setEomAddTaskSaving,
    eomEditingNotesFor, setEomEditingNotesFor, eomEditingNameFor, setEomEditingNameFor, eomDeactivateConfirm, setEomDeactivateConfirm,
    eomNameDraft, setEomNameDraft, eomExpandedNotesFor, setEomExpandedNotesFor, eomNotesDraft, setEomNotesDraft,
    eomEditingNotelet, setEomEditingNotelet, eomNoteletDraft, setEomNoteletDraft, eomNoteletSaving, setEomNoteletSaving,
    eomDraggedTaskId, setEomDraggedTaskId, eomShowTemplateManager, setEomShowTemplateManager, eomClientSettings, setEomClientSettings,
    eomShowExcludedManager, setEomShowExcludedManager, eomManagerTemplates, setEomManagerTemplates, eomManagerClientTasks, setEomManagerClientTasks,
    eomManagerLoading, setEomManagerLoading, eomManagerError, setEomManagerError, eomEditingTemplateId, setEomEditingTemplateId,
    eomTemplateDraft, setEomTemplateDraft, eomAddingNewTemplate, setEomAddingNewTemplate, eomNewTplName, setEomNewTplName,
    eomNewTplNotes, setEomNewTplNotes, eomNewTplLinkedFunction, setEomNewTplLinkedFunction, eomNewTplAlertCategories, setEomNewTplAlertCategories,
    eomAddingNewTemplateSaving, setEomAddingNewTemplateSaving, eomCashSubView, setEomCashSubView, eomCashMonthKey, setEomCashMonthKey,
    eomBankAccountsByClient, setEomBankAccountsByClient, eomBankAccountsLoadedAt, setEomBankAccountsLoadedAt, eomBankAccountsLoading, setEomBankAccountsLoading,
    eomBankAccountsLoadResult, setEomBankAccountsLoadResult, eomCashCompletedClients, setEomCashCompletedClients, eomCashProgressLoading, setEomCashProgressLoading,
    eomCashFlowQueue, setEomCashFlowQueue, eomCashFlowIndex, setEomCashFlowIndex, eomCashEntryClient, setEomCashEntryClient,
    eomCashEntryAmounts, setEomCashEntryAmounts, eomCashSaveStatus, setEomCashSaveStatus, eomCashSaveError, setEomCashSaveError,
    eomMarkActualRunning, setEomMarkActualRunning, eomBackupRunning, setEomBackupRunning, eomAlertDataReady, setEomAlertDataReady,
    eomStatusQueueRef, eomStatusTimerRef, eomCashPendingClient, setEomCashPendingClient, eomDragOverTaskId, setEomDragOverTaskId,
    eomDraggedTemplateId, setEomDraggedTemplateId, eomDraggedClientName, setEomDraggedClientName, eomDragOverClientName, setEomDragOverClientName,
    eomDragOverTemplateId, setEomDragOverTemplateId, eomCreatingNewTemplate, setEomCreatingNewTemplate, eomNewTemplateName, setEomNewTemplateName,
    eomClientTasks
  } = useEoM(sessionId);

  const {
    toolsScriptsLoaded,
    toolsFiles,
    toolsBatchRunning,
    handleToolsFilesSelect,
    startToolsBatch,
    updateToolsFile,
    processOneToolsFile
  } = useTools({
    automationCommanderSheetId,
    allOutgoingsClients,
    eomMonthKey,
    setEomStatusOverrides
  });

  const categoryLabels = {
    grossPay: "Gross pay", eeNic: "Ee NIC", erNic: "Er NIC",
    studLoan: "Student loan", eePension: "Ee pension", erPension: "Er pension", paye: "PAYE",
  };

  const toolsFileStats = (toolType) => {
    const files = (toolsFiles || []).filter(f => (f.toolType || "payroll") === toolType);
    const stillResolving = files.filter(f => f.convertStatus !== "error" && (f.convertStatus !== "ready" || !f.client));
    const readyToStart = stillResolving.length === 0 && files.some(f => f.convertStatus === "ready" && f.client && f.processStatus === "pending");
    const completeCount = files.filter(f => f.processStatus === "complete").length;
    const errorCount = files.filter(f => f.processStatus === "error").length;
    return { files, stillResolving, readyToStart, completeCount, errorCount };
  };

  // --- EOM DATA LOADING & EFFECTS ---
  
  useEffect(() => {
    setEomStatusLoading(true);
    setEomStatusError("");
    Promise.all([
      fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "eom_get_client_tasks", automationCommanderSheetId }) }).then(r => r.json()),
      fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "eom_get_month_status", monthKey: eomMonthKey, automationCommanderSheetId }) }).then(r => r.json()),
    ])
      .then(([tasksD, statusD]) => {
        if (tasksD.success) setEomAllTasks(tasksD.tasks || []);
        else setEomStatusError(tasksD.error || "Failed to load tasks");
        if (statusD.success) setEomStatusOverrides(statusD.statusOverrides || []);
        else setEomStatusError(statusD.error || "Failed to load status");
      })
      .catch(e => setEomStatusError(e.message))
      .finally(() => setEomStatusLoading(false));
  }, [automationCommanderSheetId, eomMonthKey, setEomAllTasks, setEomStatusError, setEomStatusLoading, setEomStatusOverrides]);

  useEffect(() => {
    if (eomClientSettings !== null) return;
    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_get_excluded_clients", automationCommanderSheetId }) })
      .then(r => r.json())
      .then(d => { if (d.success) setEomClientSettings(d.clients || []); })
      .catch(e => console.error("eom_get_excluded_clients error:", e));
  }, [automationCommanderSheetId, eomClientSettings, setEomClientSettings]);

  // Template loading effects moved below useCallback definitions

  useEffect(() => {
    if (eomBankAccountsByClient !== null) return;
    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_get_bank_accounts", automationCommanderSheetId }) })
      .then(r => r.json())
      .then(d => { if (d.success) { setEomBankAccountsByClient(d.accountsByClient || {}); setEomBankAccountsLoadedAt(d.loadedAt || ""); } })
      .catch(e => console.error("eom_get_bank_accounts error:", e));
  }, [automationCommanderSheetId, eomBankAccountsByClient, setEomBankAccountsByClient, setEomBankAccountsLoadedAt]);

  useEffect(() => {
    setEomCashProgressLoading(true);
    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_get_cash_balance_progress", monthKey: eomCashMonthKey, automationCommanderSheetId }) })
      .then(r => r.json())
      .then(d => { if (d.success) setEomCashCompletedClients(d.completedClients || []); })
      .catch(e => console.error("eom_get_cash_balance_progress error:", e))
      .finally(() => setEomCashProgressLoading(false));
  }, [automationCommanderSheetId, eomCashMonthKey, setEomCashCompletedClients, setEomCashProgressLoading]);

  // Cash client effect moved below useCallback definitions

  useEffect(() => {
    if (sessionId) { setEomAlertDataReady(true); return; }
    const hasAlertCheckTask = (eomAllTasks || []).some(t => t.linkedFunction === "alert_check");
    if (!hasAlertCheckTask || isLoading) return;
    startTriage().finally(() => setEomAlertDataReady(true));
  }, [eomAllTasks, isLoading, sessionId, setEomAlertDataReady, startTriage]);

  const eomCashEligibleClients = useMemo(() => {
    const excludedNames = new Set((eomClientSettings || []).filter(c => c.excluded).map(c => c.clientName));
    const cashLinkedClientNames = new Set(
      (eomAllTasks || []).filter(t => t.active && t.linkedFunction === "cash_balance").map(t => t.clientName)
    );
    return (allOutgoingsClients || []).filter(c => !excludedNames.has(c.clientName) && cashLinkedClientNames.has(c.clientName));
  }, [allOutgoingsClients, eomClientSettings, eomAllTasks]);

  // --- EOM HANDLERS ---
  const handleEomToggleClientExcluded = (clientName, excluded) => {
    setEomClientSettings(prev => {
      const list = prev || [];
      const existing = list.find(c => c.clientName === clientName);
      if (existing) return list.map(c => c.clientName === clientName ? { ...c, excluded } : c);
      return [...list, { clientName, excluded, sortOrder: null }];
    });
    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_toggle_client_excluded", clientName, excluded, automationCommanderSheetId }) })
      .catch(e => console.error("eom_toggle_client_excluded error:", e));
  };

  const persistEomClientOrder = (draggedClientName, targetClientName, orderedClientList) => {
    if (!draggedClientName || draggedClientName === targetClientName) return;
    const fromIdx = orderedClientList.indexOf(draggedClientName);
    const toIdx = orderedClientList.indexOf(targetClientName);
    if (fromIdx === -1 || toIdx === -1) return;

    const reordered = [...orderedClientList];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);

    setEomClientSettings(prev => {
      const list = prev || [];
      return reordered.map((clientName, i) => {
        const existing = list.find(c => c.clientName === clientName);
        return { clientName, excluded: existing?.excluded || false, sortOrder: (i + 1) * 10 };
      });
    });

    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_reorder_clients", orderedClientNames: reordered, automationCommanderSheetId }) })
      .catch(e => console.error("eom_reorder_clients error:", e));
  };

  const reloadEomClientTasks = () => {
    setEomClientTasksLoading(true);
    setEomClientTasksError("");
    return fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_get_client_tasks", automationCommanderSheetId }) })
      .then(r => r.json())
      .then(d => {
        if (d.success) setEomAllTasks(d.tasks || []);
        else setEomClientTasksError(d.error || "Failed to load tasks");
      })
      .catch(e => setEomClientTasksError(e.message))
      .finally(() => setEomClientTasksLoading(false));
  };

  const reloadEomTemplatesForPicker = useCallback(() => {
    setEomTemplatesError("");
    return fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_get_templates", automationCommanderSheetId }) })
      .then(r => r.json())
      .then(d => {
        if (d.success) setEomTemplates(d.templates || []);
        else setEomTemplatesError(d.error || "Failed to load templates");
      })
      .catch(e => setEomTemplatesError(e.message));
  }, [automationCommanderSheetId, setEomTemplates, setEomTemplatesError]);

  const reloadEomTemplateManager = useCallback(() => {
    setEomManagerLoading(true);
    setEomManagerError("");
    Promise.all([
      fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "eom_get_templates", automationCommanderSheetId }) }).then(r => r.json()),
      fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "eom_get_client_tasks", automationCommanderSheetId }) }).then(r => r.json()),
    ])
      .then(([templatesD, tasksD]) => {
        if (templatesD.success) setEomManagerTemplates(templatesD.templates || []);
        else setEomManagerError(templatesD.error || "Failed to load templates");
        if (tasksD.success) setEomManagerClientTasks(tasksD.tasks || []);
      })
      .catch(e => setEomManagerError(e.message))
      .finally(() => setEomManagerLoading(false));
  }, [automationCommanderSheetId, setEomManagerClientTasks, setEomManagerError, setEomManagerLoading, setEomManagerTemplates]);

  const handleLoadBankAccounts = () => {
    setEomBankAccountsLoading(true);
    setEomBankAccountsLoadResult(null);
    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_load_bank_accounts", automationCommanderSheetId }) })
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setEomBankAccountsLoadResult(d);
          fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "eom_get_bank_accounts", automationCommanderSheetId }) })
            .then(r => r.json())
            .then(d2 => { if (d2.success) { setEomBankAccountsByClient(d2.accountsByClient || {}); setEomBankAccountsLoadedAt(d2.loadedAt || ""); } });
        } else {
          setEomBankAccountsLoadResult({ error: d.error });
        }
      })
      .catch(e => setEomBankAccountsLoadResult({ error: e.message }))
      .finally(() => setEomBankAccountsLoading(false));
  };

  const setupEntryForClient = useCallback((clientName) => {
    setEomCashEntryClient(clientName);
    const accounts = (eomBankAccountsByClient && eomBankAccountsByClient[clientName]) || [];
    const blank = {};
    (accounts.length > 0 ? accounts : ["Balance"]).forEach(a => { blank[a] = ""; });
    setEomCashEntryAmounts(blank);
    setEomCashSaveStatus("idle");
    setEomCashSaveError("");
  }, [eomBankAccountsByClient, setEomCashEntryAmounts, setEomCashEntryClient, setEomCashSaveError, setEomCashSaveStatus]);

  const startCashFlow = () => {
    const allClientNames = eomCashEligibleClients.map(c => c.clientName);
    const queue = allClientNames.filter(name => !(eomCashCompletedClients || []).includes(name));
    if (queue.length === 0) return;
    setEomCashFlowQueue(queue);
    setEomCashFlowIndex(0);
    setupEntryForClient(queue[0]);
    setEomCashSubView("flow");
  };

  const selectSingleCashClient = useCallback((clientName) => {
    setupEntryForClient(clientName);
    setEomCashSubView("single");
  }, [setEomCashSubView, setupEntryForClient]);

  // --- EFFECTS THAT DEPEND ON CALLBACKS ---
  
  useEffect(() => {
    if (eomTemplates) return;
    reloadEomTemplatesForPicker();
  }, [eomTemplates, reloadEomTemplatesForPicker]);

  useEffect(() => {
    if (!eomShowTemplateManager) return;
    reloadEomTemplateManager();
  }, [eomShowTemplateManager, reloadEomTemplateManager]);

  useEffect(() => {
    if (!eomCashPendingClient || eomBankAccountsByClient === null) return;
    selectSingleCashClient(eomCashPendingClient);
    setEomCashPendingClient("");
  }, [eomBankAccountsByClient, eomCashPendingClient, selectSingleCashClient, setEomCashPendingClient]);

  const handleCashSkip = () => {
    const nextIndex = eomCashFlowIndex + 1;
    if (nextIndex >= eomCashFlowQueue.length) { setEomCashSubView("list"); return; }
    setEomCashFlowIndex(nextIndex);
    setupEntryForClient(eomCashFlowQueue[nextIndex]);
  };

  const handleCashSave = () => {
    const client = (allOutgoingsClients || []).find(c => c.clientName === eomCashEntryClient);
    if (!client) return;
    const amounts = Object.values(eomCashEntryAmounts);
    setEomCashSaveStatus("saving");
    setEomCashSaveError("");
    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_save_cash_balance", clientSheetId: client.clientSheetId,
        clientName: eomCashEntryClient, monthKey: eomCashMonthKey, amounts, automationCommanderSheetId }) })
      .then(r => r.json())
      .then(d => {
        if (!d.success) { setEomCashSaveStatus("error"); setEomCashSaveError(d.error || "Failed to save"); return; }
        setEomCashCompletedClients(prev => [...(prev || []), eomCashEntryClient]);
        if (eomCashSubView === "flow") handleCashSkip();
        else setEomCashSubView("list");
      })
      .catch(e => { setEomCashSaveStatus("error"); setEomCashSaveError(e.message); });
  };

  const handleEomCreateBackup = (taskId, targetClientName = eomDetailClient) => {
    const client = (allOutgoingsClients || []).find(c => c.clientName === targetClientName);
    if (!client) return;
    setEomBackupRunning(taskId);
    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_create_dashboard_backup", clientSheetId: client.clientSheetId, clientName: targetClientName, workMonthKey: eomMonthKey, automationCommanderSheetId }) })
      .then(r => r.json())
      .then(d => {
        if (!d.success) { setEomClientTasksError(d.error || "Failed to create backup"); return; }
        setEomStatusOverrides(prev => {
          const withoutThis = (prev || []).filter(s => !(s.clientName === targetClientName && s.taskId === taskId));
          return [...withoutThis, { clientName: targetClientName, taskId, status: "done" }];
        });
      })
      .catch(e => setEomClientTasksError(e.message))
      .finally(() => setEomBackupRunning(""));
  };

  const handleEomMarkActual = (taskId, targetClientName = eomDetailClient) => {
    const client = (allOutgoingsClients || []).find(c => c.clientName === targetClientName);
    if (!client) return;
    setEomMarkActualRunning(taskId);
    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_mark_month_actual", clientSheetId: client.clientSheetId, clientName: targetClientName, workMonthKey: eomMonthKey, automationCommanderSheetId }) })
      .then(r => r.json())
      .then(d => {
        if (!d.success) { setEomClientTasksError(d.error || "Failed to mark month actual"); return; }
        setEomStatusOverrides(prev => {
          const withoutThis = (prev || []).filter(s => !(s.clientName === targetClientName && s.taskId === taskId));
          return [...withoutThis, { clientName: targetClientName, taskId, status: "done" }];
        });
      })
      .catch(e => setEomClientTasksError(e.message))
      .finally(() => setEomMarkActualRunning(""));
  };

  const handleEomStatusChange = (taskId, newStatus, targetClientName = eomDetailClient) => {
    setEomStatusOverrides(prev => {
      const withoutThis = (prev || []).filter(s => !(s.clientName === targetClientName && s.taskId === taskId));
      return [...withoutThis, { clientName: targetClientName, taskId, status: newStatus }];
    });

    const existingIdx = eomStatusQueueRef.current.findIndex(u => u.clientName === targetClientName && u.taskId === taskId && u.monthKey === eomMonthKey);
    if (existingIdx !== -1) {
      eomStatusQueueRef.current[existingIdx].status = newStatus;
    } else {
      eomStatusQueueRef.current.push({ clientName: targetClientName, taskId, monthKey: eomMonthKey, status: newStatus });
    }

    if (eomStatusTimerRef.current) clearTimeout(eomStatusTimerRef.current);
    
    eomStatusTimerRef.current = setTimeout(() => {
      const updates = [...eomStatusQueueRef.current];
      eomStatusQueueRef.current = [];
      
      if (updates.length > 0) {
        fetch("/api/triage", { 
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "eom_update_task_status_batch", updates, automationCommanderSheetId }) 
        })
        .then(r => r.json())
        .then(d => {
          if (!d.success) setEomClientTasksError(d.error || "Failed to save status batch");
        })
        .catch(e => setEomClientTasksError(e.message));
      }
    }, 1000);
  };

  const handleEomAddTask = () => {
    if (eomAddTaskMode === "template" && !eomCreatingNewTemplate && !eomNewTaskTemplateId) return;
    if (eomAddTaskMode === "template" && eomCreatingNewTemplate && !eomNewTemplateName.trim()) return;
    if (eomAddTaskMode === "custom" && !eomNewTaskName.trim()) return;
    setEomAddTaskSaving(true);

    const finishAdd = (templateId) => {
      fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "eom_save_client_task", clientName: eomDetailClient,
          templateId: eomAddTaskMode === "template" ? templateId : undefined,
          taskName: eomAddTaskMode === "custom" ? eomNewTaskName.trim() : undefined,
          clientNotes: eomNewTaskNotes.trim(), automationCommanderSheetId }) })
        .then(r => r.json())
        .then(d => {
          if (d.success) {
            const createdNewTemplate = eomCreatingNewTemplate;
            setEomAddTaskMode(""); setEomNewTaskTemplateId(""); setEomNewTaskName(""); setEomNewTaskNotes("");
            setEomCreatingNewTemplate(false); setEomNewTemplateName("");
            if (createdNewTemplate) reloadEomTemplatesForPicker();
            reloadEomClientTasks();
          } else {
            setEomClientTasksError(d.error || "Failed to add task");
          }
        })
        .catch(e => setEomClientTasksError(e.message))
        .finally(() => setEomAddTaskSaving(false));
    };

    if (eomAddTaskMode === "template" && eomCreatingNewTemplate) {
      fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "eom_save_template", name: eomNewTemplateName.trim(), automationCommanderSheetId }) })
        .then(r => r.json())
        .then(d => { if (d.success) finishAdd(d.templateId); else setEomAddTaskSaving(false); })
        .catch(e => { console.error("eom_save_template error:", e); setEomAddTaskSaving(false); });
    } else {
      finishAdd(eomNewTaskTemplateId);
    }
  };

  const handleEomSaveNotes = (task, targetClientName = eomDetailClient) => {
    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_save_client_task", taskId: task.taskId, clientName: targetClientName,
        templateId: task.templateId || undefined, taskName: task.templateId ? undefined : task.name,
        clientNotes: eomNotesDraft, active: true, automationCommanderSheetId }) })
      .then(r => r.json())
      .then(d => {
        if (d.success) { setEomEditingNotesFor(""); reloadEomClientTasks(); }
        else setEomClientTasksError(d.error || "Failed to save notes");
      })
      .catch(e => setEomClientTasksError(e.message));
  };

  const handleEomSaveName = (task, targetClientName = eomDetailClient) => {
    if (!eomNameDraft.trim()) return;
    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_save_client_task", taskId: task.taskId, clientName: targetClientName,
        taskName: eomNameDraft.trim(), clientNotes: task.clientNotes, active: true, automationCommanderSheetId }) })
      .then(r => r.json())
      .then(d => {
        if (d.success) { setEomEditingNameFor(""); reloadEomClientTasks(); }
        else setEomClientTasksError(d.error || "Failed to save name");
      })
      .catch(e => setEomClientTasksError(e.message));
  };

  const handleEomSaveNotelet = async () => {
    if (!eomEditingNotelet) return;
    setEomNoteletSaving(true);
    const { taskId, clientName } = eomEditingNotelet;
    const newText = eomNoteletDraft.trim();
    
    setEomStatusOverrides(prev => {
      const list = prev || [];
      const existing = list.find(s => s.clientName === clientName && s.taskId === taskId);
      const withoutThis = list.filter(s => !(s.clientName === clientName && s.taskId === taskId));
      return [...withoutThis, { clientName, taskId, status: existing?.status || "pending", notelet: newText }];
    });

    try {
      await fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "eom_update_task_notelet", clientName, taskId, monthKey: eomMonthKey, notelet: newText, automationCommanderSheetId }) });
    } catch(e) { console.error(e); }
    finally {
      setEomNoteletSaving(false);
      setEomEditingNotelet(null);
    }
  };

  const handleEomToggleTaskActive = (task) => {
    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_save_client_task", taskId: task.taskId, clientName: eomDetailClient,
        templateId: task.templateId || undefined, taskName: task.templateId ? undefined : task.name,
        clientNotes: task.clientNotes, active: !task.active, automationCommanderSheetId }) })
      .then(r => r.json())
      .then(d => {
        if (d.success) reloadEomClientTasks();
        else setEomClientTasksError(d.error || "Failed to update task");
      })
      .catch(e => setEomClientTasksError(e.message));
  };

  const persistEomTaskOrder = (draggedTaskId, targetTaskId, targetClientName = eomDetailClient) => {
    if (!draggedTaskId || draggedTaskId === targetTaskId) return;
    const active = (eomAllTasks || []).filter(t => t.clientName === targetClientName && t.active).sort((a, b) => a.sortOrder - b.sortOrder);
    const fromIdx = active.findIndex(t => t.taskId === draggedTaskId);
    const toIdx = active.findIndex(t => t.taskId === targetTaskId);
    if (fromIdx === -1 || toIdx === -1) return;

    const reordered = [...active];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    const orderedTaskIds = reordered.map(t => t.taskId);

    setEomAllTasks(prev => (prev || []).map(t => {
      const newIdx = orderedTaskIds.indexOf(t.taskId);
      return newIdx === -1 ? t : { ...t, sortOrder: (newIdx + 1) * 10 };
    }));

    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_reorder_tasks", clientName: targetClientName, orderedTaskIds, automationCommanderSheetId }) })
      .catch(e => console.error("eom_reorder_tasks error:", e));
  };

  const persistEomTemplateOrder = (draggedTemplateId, targetTemplateId) => {
    if (!draggedTemplateId || draggedTemplateId === targetTemplateId) return;
    const ordered = (eomManagerTemplates || []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
    const fromIdx = ordered.findIndex(t => t.templateId === draggedTemplateId);
    const toIdx = ordered.findIndex(t => t.templateId === targetTemplateId);
    if (fromIdx === -1 || toIdx === -1) return;

    const reordered = [...ordered];
    const [moved] = reordered.splice(fromIdx, 1);
    reordered.splice(toIdx, 0, moved);
    const orderedTemplateIds = reordered.map(t => t.templateId);

    const applyNewOrder = (list) => (list || []).map(t => {
      const newIdx = orderedTemplateIds.indexOf(t.templateId);
      return newIdx === -1 ? t : { ...t, sortOrder: (newIdx + 1) * 10 };
    });
    setEomManagerTemplates(prev => applyNewOrder(prev));
    setEomTemplates(prev => prev ? applyNewOrder(prev) : prev);

    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_reorder_templates", orderedTemplateIds, automationCommanderSheetId }) })
      .catch(e => console.error("eom_reorder_templates error:", e));
  };

  const handleEomSaveTemplateEdit = (templateId) => {
    if (!eomTemplateDraft.name.trim()) return;
    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_save_template", templateId, name: eomTemplateDraft.name.trim(),
        defaultNotes: eomTemplateDraft.defaultNotes.trim(), linkedFunction: eomTemplateDraft.linkedFunction,
        active: eomTemplateDraft.active, alertCategories: eomTemplateDraft.alertCategories || "", automationCommanderSheetId }) })
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setEomEditingTemplateId("");
          reloadEomTemplatesForPicker();
          reloadEomTemplateManager();
        }
      })
      .catch(e => console.error("eom_save_template error:", e));
  };

  const handleEomCreateTemplate = () => {
    if (!eomNewTplName.trim()) return;
    setEomAddingNewTemplateSaving(true);
    fetch("/api/triage", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "eom_save_template", name: eomNewTplName.trim(),
        defaultNotes: eomNewTplNotes.trim(), linkedFunction: eomNewTplLinkedFunction,
        alertCategories: eomNewTplAlertCategories, automationCommanderSheetId }) })
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setEomAddingNewTemplate(false); setEomNewTplName(""); setEomNewTplNotes(""); setEomNewTplLinkedFunction(""); setEomNewTplAlertCategories("");
          reloadEomTemplatesForPicker();
          reloadEomTemplateManager();
        }
      })
      .catch(e => console.error("eom_save_template error:", e))
      .finally(() => setEomAddingNewTemplateSaving(false));
  };

  return (
    <div style={{ padding: "20px", maxWidth: "900px" }}>
      {eomEditingNotelet && (() => {
        const [y, m] = eomMonthKey.split("-").map(Number);
        return (
          <div style={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setEomEditingNotelet(null); }}>
            <div style={styles.modalCard}>
              <h3 style={styles.modalTitle}>Month-specific note</h3>
              <p style={styles.modalSubtitle}>Applies only to {eomEditingNotelet.clientName} for {monthName}.</p>
              <textarea value={eomNoteletDraft} onChange={e => setEomNoteletDraft(e.target.value)}
                placeholder="e.g. Waiting on client for X..." style={styles.modalTextarea} autoFocus />
              <div style={styles.modalButtons}>
                <button className="triage-btn" onClick={() => setEomEditingNotelet(null)} disabled={eomNoteletSaving} style={styles.buttonSecondary}>Cancel</button>
                <button className="triage-btn" onClick={handleEomSaveNotelet} disabled={eomNoteletSaving}
                  style={{ background: "#0066cc", color: "white", border: "none", borderRadius: "6px", padding: "9px 18px", fontWeight: "600", fontSize: "13px", cursor: "pointer", opacity: eomNoteletSaving ? 0.5 : 1 }}>
                  {eomNoteletSaving ? "Saving..." : "Save note"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {eomDeactivateConfirm && (
        <div style={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setEomDeactivateConfirm(null); }}>
          <div style={styles.modalCard}>
            <h3 style={styles.modalTitle}>Stop tracking this task?</h3>
            <p style={styles.modalSubtitle}>
              &quot;{eomDeactivateConfirm.name}&quot; will stop appearing on {eomDetailClient}&apos;s checklist. It won&apos;t be deleted — you can reactivate it later from the inactive tasks list.
            </p>
            <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
              <button onClick={() => { handleEomToggleTaskActive(eomDeactivateConfirm); setEomDeactivateConfirm(null); }}
                style={{ padding: "8px 16px", background: "#dc2626", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "13px", fontWeight: "600" }}>
                Stop tracking
              </button>
              <button onClick={() => setEomDeactivateConfirm(null)}
                style={{ padding: "8px 16px", background: "none", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      <h2 style={{ margin: "0 0 14px", fontSize: "20px", fontWeight: "700" }}>EoM</h2>

      <div style={{ display: "flex", gap: "4px", borderBottom: "1px solid #e0e0e0", marginBottom: "20px" }}>
        {[["overview", "Overview"], ["payroll", "Payroll Import"], ["time", "Time Import"], ["cash", "Cash Balances"]].map(([key, label]) => (
          <button key={key} onClick={() => setEomSubView(key)}
            style={{ padding: "8px 16px", background: "none", border: "none",
              borderBottom: eomSubView === key ? "2px solid #0066cc" : "2px solid transparent",
              color: eomSubView === key ? "#0066cc" : "#666", fontWeight: eomSubView === key ? "600" : "400",
              fontSize: "13px", cursor: "pointer" }}>
            {label}
          </button>
        ))}
      </div>

      {eomSubView === "overview" && !eomDetailClient && !eomShowTemplateManager && !eomShowExcludedManager && (() => {
        const [y, m] = eomMonthKey.split("-").map(Number);
        const monthLabel = new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
        const shiftMonth = (delta) => {
          const d = new Date(y, m - 1 + delta, 1);
          setEomMonthKey(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
        };
        const overrideByKey = {};
        (eomStatusOverrides || []).forEach(s => { overrideByKey[`${s.clientName}|||${s.taskId}`] = s.status; });
        const byClient = {};
        (eomAllTasks || []).filter(t => t.active).forEach(t => {
          let status;
          if (t.linkedFunction === "alert_check") {
            status = eomAlertDataReady ? (computeAlertCheckCount(t.clientName, t.alertCategories) === 0 ? "done" : "pending") : "pending";
          } else {
            status = overrideByKey[`${t.clientName}|||${t.taskId}`] || "pending";
          }
          if (status === "not_applicable") return;
          if (!byClient[t.clientName]) byClient[t.clientName] = { total: 0, done: 0 };
          byClient[t.clientName].total++;
          if (status === "done") byClient[t.clientName].done++;
        });
        const settingsByClient = {};
        (eomClientSettings || []).forEach(c => { settingsByClient[c.clientName] = c; });
        const alphabeticalNames = (allOutgoingsClients || []).map(c => c.clientName).slice().sort((a, b) => a.localeCompare(b));
        const clientRows = (allOutgoingsClients || [])
          .filter(c => !settingsByClient[c.clientName]?.excluded)
          .map(c => {
            const counts = byClient[c.clientName] || { total: 0, done: 0 };
            const pct = counts.total > 0 ? counts.done / counts.total : null;
            const explicitOrder = settingsByClient[c.clientName]?.sortOrder;
            const sortOrder = explicitOrder != null ? explicitOrder : 1000000 + alphabeticalNames.indexOf(c.clientName);
            return { clientName: c.clientName, ...counts, pct, sortOrder };
          }).sort((a, b) => a.sortOrder - b.sortOrder);

        return (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
              <button onClick={() => shiftMonth(-1)} style={{ padding: "4px 10px", background: "none", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>‹</button>
              <div style={{ fontSize: "15px", fontWeight: "700", minWidth: "140px", textAlign: "center" }}>{monthLabel}</div>
              <button onClick={() => shiftMonth(1)} style={{ padding: "4px 10px", background: "none", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>›</button>
              {eomStatusLoading && <Spinner />}
            </div>

            {eomStatusError && <div style={{ color: "#dc2626", fontSize: "13px", marginBottom: "14px" }}>{eomStatusError}</div>}

            <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", overflow: "hidden" }}>
              {clientRows.map((c, i) => (
                <div key={c.clientName} onClick={() => setEomDetailClient(c.clientName)}
                  style={{ display: "flex", alignItems: "center", gap: "14px", padding: "12px 18px", borderTop: i > 0 ? "1px solid #f0f0f0" : "none", cursor: "pointer" }}>
                  <div style={{ flex: "0 0 200px", fontSize: "13px", fontWeight: "600", color: "#1a1a1a" }}>{c.clientName}</div>
                  {c.total === 0 ? (
                    <div style={{ fontSize: "12px", color: "#aaa" }}>No tasks assigned yet</div>
                  ) : (
                    <>
                      <div style={{ flex: 1, height: "8px", background: "#f0f0f0", borderRadius: "4px", overflow: "hidden" }}>
                        <div style={{ width: `${c.pct * 100}%`, height: "100%",
                          background: c.pct === 1 ? "#16a34a" : c.pct === 0 ? "#dc2626" : "#f59e0b" }} />
                      </div>
                      <div style={{ flex: "0 0 70px", fontSize: "12px", color: "#666", textAlign: "right" }}>{c.done} of {c.total}</div>
                    </>
                  )}
                </div>
              ))}
              {clientRows.length === 0 && (
                <div style={{ padding: "40px 20px", fontSize: "14px", color: "#666", textAlign: "center" }}>
                  {!allClientsLoaded || eomStatusLoading ? (
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
                      <Spinner size={28} color="#0066cc" />
                      <span>Loading EoM data...</span>
                    </div>
                  ) : (
                    "No clients found."
                  )}
                </div>
              )}
            </div>

            <div style={{ marginTop: "16px", display: "flex", gap: "10px" }}>
              <button onClick={() => setEomShowTemplateManager(true)}
                style={{ padding: "6px 14px", background: "#fff", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "12px", color: "#666" }}>
                Manage Templates
              </button>
              <button onClick={() => setEomShowExcludedManager(true)}
                style={{ padding: "6px 14px", background: "#fff", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "12px", color: "#666" }}>
                Manage Clients
              </button>
            </div>

            <div style={{ marginTop: "32px" }}>
              {clientRows.map((c) => {
                const cTasks = (eomAllTasks || []).filter(t => t.clientName === c.clientName && t.active).sort((a, b) => a.sortOrder - b.sortOrder);
                if (cTasks.length === 0) return null;
                
                const statusByTaskId = {};
                const noteletByTaskId = {};
                (eomStatusOverrides || []).forEach(s => { if (s.clientName === c.clientName) { statusByTaskId[s.taskId] = s.status; noteletByTaskId[s.taskId] = s.notelet; } });

                const statePill = (taskId, current, noteletText) => {
                  const options = [["pending", "Pending", "#f59e0b"], ["done", "Done", "#16a34a"], ["not_applicable", "N/A", "#999"]];
                  const hasNotelet = !!noteletText;
                  return (
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <button 
                        onClick={() => { setEomEditingNotelet({ taskId, clientName: c.clientName }); setEomNoteletDraft(noteletText || ""); }}
                        title={hasNotelet ? noteletText : "Add month-specific note"}
                        style={{ 
                          background: hasNotelet ? "#ffeb3b" : "none", 
                          border: hasNotelet ? "1px solid #fbc02d" : "1px solid transparent", 
                          borderRadius: "6px", cursor: "pointer", padding: "4px 6px", fontSize: "15px", 
                          opacity: hasNotelet ? 1 : 0.4, color: hasNotelet ? "#f57f17" : "#999", 
                          boxShadow: hasNotelet ? "0 2px 4px rgba(0,0,0,0.15)" : "none",
                          transition: "all 0.2s" 
                        }}>
                        {hasNotelet ? "💬" : "🗨️"}
                      </button>
                      <div style={{ display: "flex", gap: "4px" }}>
                        {options.map(([val, label, color]) => (
                          <button key={val} onClick={() => handleEomStatusChange(taskId, val, c.clientName)}
                            style={{ padding: "3px 9px", fontSize: "11px", borderRadius: "5px", cursor: "pointer",
                              border: `1px solid ${current === val ? color : "#ddd"}`,
                              background: current === val ? color : "#fff",
                              color: current === val ? "#fff" : "#666", fontWeight: current === val ? "600" : "400" }}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                };

                const alertCheckPill = (categoriesStr) => {
                  if (!eomAlertDataReady) return <span style={{ fontSize: "11px", color: "#999", padding: "3px 9px" }}><Spinner /> Checking...</span>;
                  const count = computeAlertCheckCount(c.clientName, categoriesStr);
                  const isDone = count === 0;
                  return (
                    <span title={isDone ? "No active alerts in the selected categories" : `${count} active alert${count !== 1 ? "s" : ""} in the selected categories`}
                      style={{ padding: "3px 9px", fontSize: "11px", borderRadius: "5px", fontWeight: "600",
                        border: `1px solid ${isDone ? "#16a34a" : "#f59e0b"}`, background: isDone ? "#16a34a" : "#f59e0b", color: "#fff" }}>
                      {isDone ? "Done" : `Pending (${count})`}
                    </span>
                  );
                };

                return (
                  <div key={c.clientName} style={{ marginBottom: "24px" }}>
                    <h3 style={{ fontSize: "16px", fontWeight: "700", color: "#1a1a1a", marginBottom: "12px", borderBottom: "2px solid #e0e0e0", paddingBottom: "6px" }}>{c.clientName}</h3>
                    <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0" }}>
                      {cTasks.map((t, i) => (
                        <div key={t.taskId}
                          draggable
                          onDragStart={() => setEomDraggedTaskId(t.taskId)}
                          onDragOver={e => { e.preventDefault(); if (eomDragOverTaskId !== t.taskId) setEomDragOverTaskId(t.taskId); }}
                          onDragLeave={() => setEomDragOverTaskId(prev => prev === t.taskId ? null : prev)}
                          onDrop={e => { e.preventDefault(); persistEomTaskOrder(eomDraggedTaskId, t.taskId, c.clientName); setEomDraggedTaskId(null); setEomDragOverTaskId(null); }}
                          onDragEnd={() => { setEomDraggedTaskId(null); setEomDragOverTaskId(null); }}
                          style={{ padding: "8px 18px", borderTop: i > 0 ? "1px solid #f0f0f0" : "none",
                            background: eomDragOverTaskId === t.taskId ? "#f0f7ff" : "transparent",
                            opacity: eomDraggedTaskId === t.taskId ? 0.4 : 1 }}>
                          <div style={{ display: "flex", alignItems: "flex-start", gap: "14px" }}>
                            <div title="Drag to reorder" style={{ cursor: "grab", color: "#ccc", fontSize: "14px", lineHeight: "20px", userSelect: "none" }}>⠿</div>
                            <div style={{ flex: 1, fontSize: "13px", fontWeight: "600", color: "#1a1a1a" }}>
                              {eomEditingNameFor === t.taskId ? (
                                <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                                  <input value={eomNameDraft} onChange={e => setEomNameDraft(e.target.value)} autoFocus
                                    style={{ flex: 1, padding: "4px 7px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "13px", fontWeight: "600" }} />
                                  <button onClick={() => handleEomSaveName(t, c.clientName)} style={{ padding: "4px 9px", background: "#0066cc", color: "#fff", border: "none", borderRadius: "5px", cursor: "pointer", fontSize: "11px", fontWeight: "600" }}>Save</button>
                                  <button onClick={() => setEomEditingNameFor("")} style={{ padding: "4px 9px", background: "none", border: "1px solid #ddd", borderRadius: "5px", cursor: "pointer", fontSize: "11px" }}>Cancel</button>
                                </div>
                              ) : (
                                <span onClick={t.templateId ? undefined : () => { setEomEditingNameFor(t.taskId); setEomNameDraft(t.name); }}
                                  title={t.templateId ? "Shared template — edit via Manage Templates" : "Click to rename"}
                                  style={{ cursor: t.templateId ? "default" : "pointer" }}>
                                  {t.name}
                                </span>
                              )}
                              {t.templateId && <span style={{ marginLeft: "6px", fontSize: "10px", color: "#888", fontWeight: "400" }}>(shared)</span>}
                              {t.linkedFunction === "salaries" && (
                                <button onClick={() => setEomSubView("payroll")}
                                  style={{ marginLeft: "8px", padding: "2px 8px", background: "#eef4ff", border: "1px solid #cfe0ff", borderRadius: "10px", color: "#0066cc", cursor: "pointer", fontSize: "10px", fontWeight: "600" }}>
                                  Import Payroll →
                                </button>
                              )}
                              {t.linkedFunction === "time_import" && (
                                <button onClick={() => setEomSubView("time")}
                                  style={{ marginLeft: "8px", padding: "2px 8px", background: "#eef4ff", border: "1px solid #cfe0ff", borderRadius: "10px", color: "#0066cc", cursor: "pointer", fontSize: "10px", fontWeight: "600" }}>
                                  Import Time →
                                </button>
                              )}
                              {t.linkedFunction === "mark_actual" && (() => {
                                const targetKey = eomWorkMonthToTargetMonth(eomMonthKey);
                                const [ty, tm] = (targetKey || "").split("-").map(Number);
                                const targetLabel = ty ? new Date(ty, tm - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : "";
                                return (
                                  <button onClick={() => handleEomMarkActual(t.taskId, c.clientName)} disabled={eomMarkActualRunning === t.taskId}
                                    title={`Writes &quot;Actual&quot; to the ${targetLabel} column on the Performance tab`}
                                    style={{ marginLeft: "8px", padding: "2px 8px", background: "#eef4ff", border: "1px solid #cfe0ff", borderRadius: "10px",
                                      color: "#0066cc", cursor: eomMarkActualRunning === t.taskId ? "default" : "pointer", fontSize: "10px", fontWeight: "600" }}>
                                    {eomMarkActualRunning === t.taskId ? "Marking..." : `Mark ${targetLabel} Actual`}
                                  </button>
                                );
                              })()}
                              {t.linkedFunction === "create_backup" && (
                                <button onClick={() => handleEomCreateBackup(t.taskId, c.clientName)} disabled={eomBackupRunning === t.taskId}
                                  title={`Copies the Dashboard tab to the backup sheet as values only`}
                                  style={{ marginLeft: "8px", padding: "2px 8px", background: "#eef4ff", border: "1px solid #cfe0ff", borderRadius: "10px",
                                    color: "#0066cc", cursor: eomBackupRunning === t.taskId ? "default" : "pointer", fontSize: "10px", fontWeight: "600" }}>
                                  {eomBackupRunning === t.taskId ? "Creating..." : `Create Backup`}
                                </button>
                              )}
                              {t.linkedFunction === "cash_balance" && (
                                <button onClick={() => { setEomCashPendingClient(c.clientName); setEomSubView("cash"); }}
                                  style={{ marginLeft: "8px", padding: "2px 8px", background: "#eef4ff", border: "1px solid #cfe0ff", borderRadius: "10px", color: "#0066cc", cursor: "pointer", fontSize: "10px", fontWeight: "600" }}>
                                  Enter Cash Balance →
                                </button>
                              )}
                              {t.linkedFunction === "alert_check" && (
                                <span style={{ marginLeft: "8px", fontSize: "10px", color: "#888" }}>
                                  ({(t.alertCategories || "").split(",").filter(Boolean).map(cat => ({ invoice: "InvComp", expense: "DirComp", crm: "CRMComp" }[cat])).join(", ") || "no categories set"})
                                </span>
                              )}
                            </div>
                            {t.linkedFunction === "alert_check" ? alertCheckPill(t.alertCategories) : statePill(t.taskId, statusByTaskId[t.taskId] || "pending", noteletByTaskId[t.taskId])}
                            <button onClick={() => setEomExpandedNotesFor(prev => {
                                const next = new Set(prev);
                                if (next.has(t.taskId)) next.delete(t.taskId); else next.add(t.taskId);
                                return next;
                              })}
                              title={t.clientNotes ? "Show/hide note" : "Add note"}
                              style={{ background: "none", border: "none", cursor: "pointer", fontSize: "13px", padding: "3px",
                                color: t.clientNotes ? "#0066cc" : "#bbb", fontWeight: t.clientNotes ? "700" : "400" }}>
                              {eomExpandedNotesFor.has(t.taskId) ? "−" : "+"}
                            </button>
                          </div>
                          {(eomExpandedNotesFor.has(t.taskId) || eomEditingNotesFor === t.taskId) && (
                            eomEditingNotesFor === t.taskId ? (
                              <div style={{ marginTop: "8px", display: "flex", gap: "8px" }}>
                                <input value={eomNotesDraft} onChange={e => setEomNotesDraft(e.target.value)} placeholder="Client-specific notes..."
                                  style={{ flex: 1, padding: "5px 8px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "12px" }} />
                                <button onClick={() => handleEomSaveNotes(t, c.clientName)} style={{ padding: "5px 10px", background: "#0066cc", color: "#fff", border: "none", borderRadius: "5px", cursor: "pointer", fontSize: "11px" }}>Save</button>
                                <button onClick={() => setEomEditingNotesFor("")} style={{ padding: "5px 10px", background: "none", border: "1px solid #ddd", borderRadius: "5px", cursor: "pointer", fontSize: "11px" }}>Cancel</button>
                              </div>
                            ) : (
                              <div onClick={() => { setEomEditingNotesFor(t.taskId); setEomNotesDraft(t.clientNotes || ""); }}
                                style={{ marginTop: "6px", fontSize: "12px", color: t.clientNotes ? "#666" : "#bbb", cursor: "pointer" }}>
                                {t.clientNotes || "+ add note"}
                              </div>
                            )
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {eomSubView === "overview" && eomShowExcludedManager && (() => {
        const settingsByClient = {};
        (eomClientSettings || []).forEach(c => { settingsByClient[c.clientName] = c; });
        const alphabeticalNames = (allOutgoingsClients || []).map(c => c.clientName).slice().sort((a, b) => a.localeCompare(b));
        const orderedClients = (allOutgoingsClients || []).map(c => {
          const explicitOrder = settingsByClient[c.clientName]?.sortOrder;
          const sortOrder = explicitOrder != null ? explicitOrder : 1000000 + alphabeticalNames.indexOf(c.clientName);
          return { clientName: c.clientName, excluded: settingsByClient[c.clientName]?.excluded || false, sortOrder };
        }).sort((a, b) => a.sortOrder - b.sortOrder);
        const orderedClientNames = orderedClients.map(c => c.clientName);

        return (
          <div>
            <button onClick={() => setEomShowExcludedManager(false)}
              style={{ background: "none", border: "none", color: "#0066cc", cursor: "pointer", fontSize: "13px", padding: "0 0 12px", display: "block" }}>
              ‹ Back to overview
            </button>
            <h3 style={{ margin: "0 0 6px", fontSize: "16px", fontWeight: "700" }}>Manage Clients</h3>
            <p style={{ margin: "0 0 16px", fontSize: "13px", color: "#666" }}>
              Drag to set the order clients appear in on the EoM overview. Excluded clients won&apos;t appear there at all — for clients on AutoUpdates that don&apos;t have any monthly tasks to complete.
            </p>
            <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", overflow: "hidden" }}>
              {orderedClients.map((c, i) => (
                <div key={c.clientName}
                  draggable
                  onDragStart={() => setEomDraggedClientName(c.clientName)}
                  onDragOver={e => { e.preventDefault(); if (eomDragOverClientName !== c.clientName) setEomDragOverClientName(c.clientName); }}
                  onDragLeave={() => setEomDragOverClientName(prev => prev === c.clientName ? null : prev)}
                  onDrop={e => { e.preventDefault(); persistEomClientOrder(eomDraggedClientName, c.clientName, orderedClientNames); setEomDraggedClientName(null); setEomDragOverClientName(null); }}
                  onDragEnd={() => { setEomDraggedClientName(null); setEomDragOverClientName(null); }}
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 18px",
                    borderTop: i > 0 ? "1px solid #f0f0f0" : "none",
                    background: eomDragOverClientName === c.clientName ? "#f0f7ff" : "transparent",
                    opacity: eomDraggedClientName === c.clientName ? 0.4 : 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <div title="Drag to reorder" style={{ cursor: "grab", color: "#ccc", fontSize: "14px", userSelect: "none" }}>⠿</div>
                    <div style={{ fontSize: "13px", color: c.excluded ? "#999" : "#1a1a1a", fontWeight: "600" }}>{c.clientName}</div>
                  </div>
                  <label style={{ fontSize: "12px", color: "#666", display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                    <input type="checkbox" checked={c.excluded} onChange={e => handleEomToggleClientExcluded(c.clientName, e.target.checked)} />
                    Excluded from EoM
                  </label>
                </div>
              ))}
              {orderedClients.length === 0 && (
                <div style={{ padding: "20px", fontSize: "13px", color: "#999", textAlign: "center" }}>No clients found.</div>
              )}
            </div>
          </div>
        );
      })()}

      {eomSubView === "overview" && eomShowTemplateManager && !eomShowExcludedManager && (() => {
        const usageCount = {};
        (eomManagerClientTasks || []).forEach(t => {
          if (t.templateId && t.active) usageCount[t.templateId] = (usageCount[t.templateId] || 0) + 1;
        });

        const startEditingTemplate = (tpl) => {
          setEomEditingTemplateId(tpl.templateId);
          setEomTemplateDraft({ name: tpl.name, defaultNotes: tpl.defaultNotes || "", linkedFunction: tpl.linkedFunction || "", active: tpl.active, alertCategories: tpl.alertCategories || "" });
        };

        return (
          <div>
            <button onClick={() => { setEomShowTemplateManager(false); setEomEditingTemplateId(""); setEomAddingNewTemplate(false); }}
              style={{ background: "none", border: "none", color: "#0066cc", cursor: "pointer", fontSize: "13px", padding: "0 0 12px", display: "block" }}>
              ‹ Back to overview
            </button>

            <h3 style={{ margin: "0 0 14px", fontSize: "16px", fontWeight: "700" }}>Manage Templates</h3>

            {eomManagerLoading && <div style={{ fontSize: "13px", color: "#666", marginBottom: "14px" }}><Spinner /> Loading...</div>}
            {eomManagerError && <div style={{ color: "#dc2626", fontSize: "13px", marginBottom: "14px" }}>{eomManagerError}</div>}

            <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", marginBottom: "16px" }}>
              {(eomManagerTemplates || []).slice().sort((a, b) => a.sortOrder - b.sortOrder).map((tpl, i) => (
                <div key={tpl.templateId}
                  draggable
                  onDragStart={() => setEomDraggedTemplateId(tpl.templateId)}
                  onDragOver={e => { e.preventDefault(); if (eomDragOverTemplateId !== tpl.templateId) setEomDragOverTemplateId(tpl.templateId); }}
                  onDragLeave={() => setEomDragOverTemplateId(prev => prev === tpl.templateId ? null : prev)}
                  onDrop={e => { e.preventDefault(); persistEomTemplateOrder(eomDraggedTemplateId, tpl.templateId); setEomDraggedTemplateId(null); setEomDragOverTemplateId(null); }}
                  onDragEnd={() => { setEomDraggedTemplateId(null); setEomDragOverTemplateId(null); }}
                  style={{ padding: "12px 18px", borderTop: i > 0 ? "1px solid #f0f0f0" : "none", opacity: tpl.active ? (eomDraggedTemplateId === tpl.templateId ? 0.4 : 1) : 0.55,
                    background: eomDragOverTemplateId === tpl.templateId ? "#f0f7ff" : "transparent" }}>
                  {eomEditingTemplateId === tpl.templateId ? (
                    <div>
                      <input value={eomTemplateDraft.name} onChange={e => setEomTemplateDraft(d => ({ ...d, name: e.target.value }))} placeholder="Template name"
                        style={{ width: "100%", padding: "6px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "13px", marginBottom: "6px", boxSizing: "border-box", fontWeight: "600" }} />
                      <input value={eomTemplateDraft.defaultNotes} onChange={e => setEomTemplateDraft(d => ({ ...d, defaultNotes: e.target.value }))} placeholder="Default notes (optional)"
                        style={{ width: "100%", padding: "6px 9px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "12px", marginBottom: "6px", boxSizing: "border-box" }} />
                      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
                        <label style={{ fontSize: "12px", color: "#666" }}>Linked function:</label>
                        <select value={eomTemplateDraft.linkedFunction} onChange={e => setEomTemplateDraft(d => ({ ...d, linkedFunction: e.target.value }))}
                          style={{ padding: "4px 8px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "12px" }}>
                          <option value="">None</option>
                          <option value="salaries">Salaries</option>
                          <option value="cash_balance">Cash Balance</option>
                          <option value="mark_actual">Mark Month Actual</option>
                          <option value="create_backup">Create Dashboard Backup</option>
                          <option value="time_import">Time Report Import</option>
                          <option value="alert_check">Alert Check (InvComp/DirComp/CRMComp)</option>
                        </select>
                        <label style={{ fontSize: "12px", color: "#666", display: "flex", alignItems: "center", gap: "4px", marginLeft: "10px" }}>
                          <input type="checkbox" checked={eomTemplateDraft.active} onChange={e => setEomTemplateDraft(d => ({ ...d, active: e.target.checked }))} />
                          Active
                        </label>
                      </div>
                      {eomTemplateDraft.linkedFunction === "alert_check" && (
                        <div style={{ display: "flex", gap: "12px", marginBottom: "8px", paddingLeft: "2px" }}>
                          {[["invoice", "InvComp"], ["expense", "DirComp"], ["crm", "CRMComp"]].map(([val, label]) => {
                            const cats = (eomTemplateDraft.alertCategories || "").split(",").filter(Boolean);
                            const checked = cats.includes(val);
                            return (
                              <label key={val} style={{ fontSize: "12px", color: "#666", display: "flex", alignItems: "center", gap: "4px" }}>
                                <input type="checkbox" checked={checked} onChange={e => {
                                  const next = e.target.checked ? [...cats, val] : cats.filter(c => c !== val);
                                  setEomTemplateDraft(d => ({ ...d, alertCategories: next.join(",") }));
                                }} />
                                {label}
                              </label>
                            );
                          })}
                        </div>
                      )}
                      <div style={{ display: "flex", gap: "8px" }}>
                        <button onClick={() => handleEomSaveTemplateEdit(tpl.templateId)}
                          style={{ padding: "5px 12px", background: "#0066cc", color: "#fff", border: "none", borderRadius: "5px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>
                          Save
                        </button>
                        <button onClick={() => setEomEditingTemplateId("")}
                          style={{ padding: "5px 12px", background: "none", border: "1px solid #ddd", borderRadius: "5px", cursor: "pointer", fontSize: "12px" }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div onClick={() => startEditingTemplate(tpl)} style={{ cursor: "pointer", display: "flex", alignItems: "flex-start", gap: "10px" }}>
                      <div onClick={e => e.stopPropagation()} title="Drag to reorder" style={{ cursor: "grab", color: "#ccc", fontSize: "14px", lineHeight: "20px", userSelect: "none" }}>⠿</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: "13px", fontWeight: "600", color: "#1a1a1a" }}>
                          {tpl.name}
                          {!tpl.active && <span style={{ marginLeft: "6px", fontSize: "10px", color: "#b45309" }}>(inactive)</span>}
                          {tpl.linkedFunction && (
                            <span style={{ marginLeft: "6px", fontSize: "10px", color: "#0066cc" }}>
                              (linked: {({ salaries: "salaries", cash_balance: "cash balance", mark_actual: "mark actual", create_backup: "create backup", alert_check: "alert check", time_import: "time import" }[tpl.linkedFunction]) || tpl.linkedFunction})
                            </span>
                          )}
                        </div>
                        {tpl.defaultNotes && <div style={{ fontSize: "12px", color: "#888", marginTop: "2px" }}>{tpl.defaultNotes}</div>}
                      </div>
                      <div style={{ fontSize: "11px", color: "#999", whiteSpace: "nowrap" }}>
                        used by {usageCount[tpl.templateId] || 0} client{(usageCount[tpl.templateId] || 0) !== 1 ? "s" : ""}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {(eomManagerTemplates || []).length === 0 && !eomManagerLoading && (
                <div style={{ padding: "20px", fontSize: "13px", color: "#999", textAlign: "center" }}>No templates yet.</div>
              )}
            </div>

            <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "14px 18px" }}>
              {!eomAddingNewTemplate ? (
                <button onClick={() => setEomAddingNewTemplate(true)}
                  style={{ padding: "6px 12px", background: "#fff", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "12px" }}>
                  + Add new template
                </button>
              ) : (
                <div>
                  <input value={eomNewTplName} onChange={e => setEomNewTplName(e.target.value)} placeholder="Template name"
                    style={{ width: "100%", padding: "7px 10px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "13px", marginBottom: "8px", boxSizing: "border-box" }} />
                  <input value={eomNewTplNotes} onChange={e => setEomNewTplNotes(e.target.value)} placeholder="Default notes (optional)"
                    style={{ width: "100%", padding: "7px 10px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "13px", marginBottom: "8px", boxSizing: "border-box" }} />
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
                    <label style={{ fontSize: "12px", color: "#666" }}>Linked function:</label>
                    <select value={eomNewTplLinkedFunction} onChange={e => setEomNewTplLinkedFunction(e.target.value)}
                      style={{ padding: "5px 8px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "12px" }}>
                      <option value="">None</option>
                      <option value="salaries">Salaries</option>
                      <option value="cash_balance">Cash Balance</option>
                      <option value="mark_actual">Mark Month Actual</option>
                      <option value="create_backup">Create Dashboard Backup</option>
                      <option value="time_import">Time Report Import</option>
                      <option value="alert_check">Alert Check (InvComp/DirComp/CRMComp)</option>
                    </select>
                  </div>
                  {eomNewTplLinkedFunction === "alert_check" && (
                    <div style={{ display: "flex", gap: "12px", marginBottom: "10px", paddingLeft: "2px" }}>
                      {[["invoice", "InvComp"], ["expense", "DirComp"], ["crm", "CRMComp"]].map(([val, label]) => {
                        const cats = eomNewTplAlertCategories.split(",").filter(Boolean);
                        const checked = cats.includes(val);
                        return (
                          <label key={val} style={{ fontSize: "12px", color: "#666", display: "flex", alignItems: "center", gap: "4px" }}>
                            <input type="checkbox" checked={checked} onChange={e => {
                              const next = e.target.checked ? [...cats, val] : cats.filter(c => c !== val);
                              setEomNewTplAlertCategories(next.join(","));
                            }} />
                            {label}
                          </label>
                        );
                      })}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button disabled={eomAddingNewTemplateSaving} onClick={handleEomCreateTemplate}
                      style={{ padding: "6px 14px", background: eomAddingNewTemplateSaving ? "#ccc" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: eomAddingNewTemplateSaving ? "default" : "pointer", fontSize: "12px", fontWeight: "600" }}>
                      {eomAddingNewTemplateSaving ? "Saving..." : "Add"}
                    </button>
                    <button onClick={() => { setEomAddingNewTemplate(false); setEomNewTplName(""); setEomNewTplNotes(""); setEomNewTplLinkedFunction(""); setEomNewTplAlertCategories(""); }}
                      style={{ padding: "6px 14px", background: "none", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "12px" }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {eomSubView === "overview" && eomDetailClient && !eomShowTemplateManager && !eomShowExcludedManager && (() => {
        const [y, m] = eomMonthKey.split("-").map(Number);
        const monthLabel = new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
        const shiftMonth = (delta) => {
          const d = new Date(y, m - 1 + delta, 1);
          setEomMonthKey(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
        };
        const statusByTaskId = {};
        const noteletByTaskId = {};
        (eomStatusOverrides || []).forEach(s => { if (s.clientName === eomDetailClient) { statusByTaskId[s.taskId] = s.status; noteletByTaskId[s.taskId] = s.notelet; } });
        const activeTasks = (eomClientTasks || []).filter(t => t.active).sort((a, b) => a.sortOrder - b.sortOrder);
        const inactiveTasks = (eomClientTasks || []).filter(t => !t.active);
        const statePill = (taskId, current, noteletText) => {
          const options = [["pending", "Pending", "#f59e0b"], ["done", "Done", "#16a34a"], ["not_applicable", "N/A", "#999"]];
          const hasNotelet = !!noteletText;
          return (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <button 
                onClick={() => { setEomEditingNotelet({ taskId, clientName: eomDetailClient }); setEomNoteletDraft(noteletText || ""); }}
                title={hasNotelet ? noteletText : "Add month-specific note"}
                style={{ 
                  background: hasNotelet ? "#ffeb3b" : "none", 
                  border: hasNotelet ? "1px solid #fbc02d" : "1px solid transparent", 
                  borderRadius: "6px", cursor: "pointer", padding: "4px 6px", fontSize: "15px", 
                  opacity: hasNotelet ? 1 : 0.4, color: hasNotelet ? "#f57f17" : "#999", 
                  boxShadow: hasNotelet ? "0 2px 4px rgba(0,0,0,0.15)" : "none",
                  transition: "all 0.2s" 
                }}>
                {hasNotelet ? "💬" : "🗨️"}
              </button>
              <div style={{ display: "flex", gap: "4px" }}>
                {options.map(([val, label, color]) => (
                  <button key={val} onClick={() => handleEomStatusChange(taskId, val)}
                    style={{ padding: "3px 9px", fontSize: "11px", borderRadius: "5px", cursor: "pointer",
                      border: `1px solid ${current === val ? color : "#ddd"}`,
                      background: current === val ? color : "#fff",
                      color: current === val ? "#fff" : "#666", fontWeight: current === val ? "600" : "400" }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          );
        };

        const alertCheckPill = (categoriesStr) => {
          if (!eomAlertDataReady) {
            return <span style={{ fontSize: "11px", color: "#999", padding: "3px 9px" }}><Spinner /> Checking...</span>;
          }
          const count = computeAlertCheckCount(eomDetailClient, categoriesStr);
          const isDone = count === 0;
          return (
            <span title={isDone ? "No active alerts in the selected categories" : `${count} active alert${count !== 1 ? "s" : ""} in the selected categories`}
              style={{ padding: "3px 9px", fontSize: "11px", borderRadius: "5px", fontWeight: "600",
                border: `1px solid ${isDone ? "#16a34a" : "#f59e0b"}`, background: isDone ? "#16a34a" : "#f59e0b", color: "#fff" }}>
              {isDone ? "Done" : `Pending (${count})`}
            </span>
          );
        };

        return (
          <div>
            <button onClick={() => { setEomDetailClient(null); setEomAddTaskMode(""); setEomEditingNotesFor(""); }}
              style={{ background: "none", border: "none", color: "#0066cc", cursor: "pointer", fontSize: "13px", padding: "0 0 12px", display: "block" }}>
              ‹ Back to overview
            </button>

            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
              <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700" }}>{eomDetailClient}</h3>
              <div style={{ flex: 1 }} />
              <button onClick={() => shiftMonth(-1)} style={{ padding: "4px 10px", background: "none", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>‹</button>
              <div style={{ fontSize: "14px", fontWeight: "600", minWidth: "130px", textAlign: "center" }}>{monthLabel}</div>
              <button onClick={() => shiftMonth(1)} style={{ padding: "4px 10px", background: "none", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>›</button>
              {(eomStatusLoading || eomClientTasksLoading) && <Spinner />}
            </div>

            {eomStatusError && <div style={{ color: "#dc2626", fontSize: "13px", marginBottom: "14px" }}>{eomStatusError}</div>}
            {eomClientTasksError && <div style={{ color: "#dc2626", fontSize: "13px", marginBottom: "14px" }}>{eomClientTasksError}</div>}

            <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", marginBottom: "16px" }}>
              {activeTasks.map((t, i) => (
                <div key={t.taskId}
                  draggable
                  onDragStart={() => setEomDraggedTaskId(t.taskId)}
                  onDragOver={e => { e.preventDefault(); if (eomDragOverTaskId !== t.taskId) setEomDragOverTaskId(t.taskId); }}
                  onDragLeave={() => setEomDragOverTaskId(prev => prev === t.taskId ? null : prev)}
                  onDrop={e => { e.preventDefault(); persistEomTaskOrder(eomDraggedTaskId, t.taskId); setEomDraggedTaskId(null); setEomDragOverTaskId(null); }}
                  onDragEnd={() => { setEomDraggedTaskId(null); setEomDragOverTaskId(null); }}
                  style={{ padding: "8px 18px", borderTop: i > 0 ? "1px solid #f0f0f0" : "none",
                    background: eomDragOverTaskId === t.taskId ? "#f0f7ff" : "transparent",
                    opacity: eomDraggedTaskId === t.taskId ? 0.4 : 1 }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: "14px" }}>
                    <div title="Drag to reorder" style={{ cursor: "grab", color: "#ccc", fontSize: "14px", lineHeight: "20px", userSelect: "none" }}>⠿</div>
                    <div style={{ flex: 1, fontSize: "13px", fontWeight: "600", color: "#1a1a1a" }}>
                      {eomEditingNameFor === t.taskId ? (
                        <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                          <input value={eomNameDraft} onChange={e => setEomNameDraft(e.target.value)} autoFocus
                            style={{ flex: 1, padding: "4px 7px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "13px", fontWeight: "600" }} />
                          <button onClick={() => handleEomSaveName(t)} style={{ padding: "4px 9px", background: "#0066cc", color: "#fff", border: "none", borderRadius: "5px", cursor: "pointer", fontSize: "11px", fontWeight: "600" }}>Save</button>
                          <button onClick={() => setEomEditingNameFor("")} style={{ padding: "4px 9px", background: "none", border: "1px solid #ddd", borderRadius: "5px", cursor: "pointer", fontSize: "11px" }}>Cancel</button>
                        </div>
                      ) : (
                        <span onClick={t.templateId ? undefined : () => { setEomEditingNameFor(t.taskId); setEomNameDraft(t.name); }}
                          title={t.templateId ? "Shared template — edit via Manage Templates" : "Click to rename"}
                          style={{ cursor: t.templateId ? "default" : "pointer" }}>
                          {t.name}
                        </span>
                      )}
                      {t.templateId && <span style={{ marginLeft: "6px", fontSize: "10px", color: "#888", fontWeight: "400" }}>(shared)</span>}
                      {t.linkedFunction === "salaries" && (
                        <button onClick={() => setEomSubView("payroll")}
                          style={{ marginLeft: "8px", padding: "2px 8px", background: "#eef4ff", border: "1px solid #cfe0ff", borderRadius: "10px", color: "#0066cc", cursor: "pointer", fontSize: "10px", fontWeight: "600" }}>
                          Import Payroll →
                        </button>
                      )}
                      {t.linkedFunction === "time_import" && (
                        <button onClick={() => setEomSubView("time")}
                          style={{ marginLeft: "8px", padding: "2px 8px", background: "#eef4ff", border: "1px solid #cfe0ff", borderRadius: "10px", color: "#0066cc", cursor: "pointer", fontSize: "10px", fontWeight: "600" }}>
                          Import Time →
                        </button>
                      )}
                      {t.linkedFunction === "mark_actual" && (() => {
                        const targetKey = eomWorkMonthToTargetMonth(eomMonthKey);
                        const [ty, tm] = (targetKey || "").split("-").map(Number);
                        const targetLabel = ty ? new Date(ty, tm - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : "";
                        return (
                          <button onClick={() => handleEomMarkActual(t.taskId)} disabled={eomMarkActualRunning === t.taskId}
                            title={`Writes &quot;Actual&quot; to the ${targetLabel} column on the Performance tab`}
                            style={{ marginLeft: "8px", padding: "2px 8px", background: "#eef4ff", border: "1px solid #cfe0ff", borderRadius: "10px",
                              color: "#0066cc", cursor: eomMarkActualRunning === t.taskId ? "default" : "pointer", fontSize: "10px", fontWeight: "600" }}>
                            {eomMarkActualRunning === t.taskId ? "Marking..." : `Mark ${targetLabel} Actual`}
                          </button>
                        );
                      })()}
                      {t.linkedFunction === "create_backup" && (
                        <button onClick={() => handleEomCreateBackup(t.taskId)} disabled={eomBackupRunning === t.taskId}
                          title={`Copies the Dashboard tab to the backup sheet as values only`}
                          style={{ marginLeft: "8px", padding: "2px 8px", background: "#eef4ff", border: "1px solid #cfe0ff", borderRadius: "10px",
                            color: "#0066cc", cursor: eomBackupRunning === t.taskId ? "default" : "pointer", fontSize: "10px", fontWeight: "600" }}>
                          {eomBackupRunning === t.taskId ? "Creating..." : `Create Backup`}
                        </button>
                      )}
                      {t.linkedFunction === "cash_balance" && (
                        <button onClick={() => { setEomCashPendingClient(eomDetailClient); setEomSubView("cash"); }}
                          style={{ marginLeft: "8px", padding: "2px 8px", background: "#eef4ff", border: "1px solid #cfe0ff", borderRadius: "10px", color: "#0066cc", cursor: "pointer", fontSize: "10px", fontWeight: "600" }}>
                          Enter Cash Balance →
                        </button>
                      )}
                      {t.linkedFunction === "alert_check" && (
                        <span style={{ marginLeft: "8px", fontSize: "10px", color: "#888" }}>
                          ({(t.alertCategories || "").split(",").filter(Boolean).map(c => ({ invoice: "InvComp", expense: "DirComp", crm: "CRMComp" }[c])).join(", ") || "no categories set"})
                        </span>
                      )}
                    </div>
                    {t.linkedFunction === "alert_check" ? alertCheckPill(t.alertCategories) : statePill(t.taskId, statusByTaskId[t.taskId] || "pending", noteletByTaskId[t.taskId])}
                    <button onClick={() => setEomExpandedNotesFor(prev => {
                        const next = new Set(prev);
                        if (next.has(t.taskId)) next.delete(t.taskId); else next.add(t.taskId);
                        return next;
                      })}
                      title={t.clientNotes ? "Show/hide note" : "Add note"}
                      style={{ background: "none", border: "none", cursor: "pointer", fontSize: "13px", padding: "3px",
                        color: t.clientNotes ? "#0066cc" : "#bbb", fontWeight: t.clientNotes ? "700" : "400" }}>
                      {eomExpandedNotesFor.has(t.taskId) ? "−" : "+"}
                    </button>
                    <button onClick={() => setEomDeactivateConfirm(t)} title="Stop tracking this task for this client"
                      style={{ background: "none", border: "none", color: "#bbb", cursor: "pointer", fontSize: "12px", padding: "3px" }}>✕</button>
                  </div>
                  {(eomExpandedNotesFor.has(t.taskId) || eomEditingNotesFor === t.taskId) && (
                    eomEditingNotesFor === t.taskId ? (
                      <div style={{ marginTop: "8px", display: "flex", gap: "8px" }}>
                        <input value={eomNotesDraft} onChange={e => setEomNotesDraft(e.target.value)} placeholder="Client-specific notes..."
                          style={{ flex: 1, padding: "5px 8px", border: "1px solid #ddd", borderRadius: "5px", fontSize: "12px" }} />
                        <button onClick={() => handleEomSaveNotes(t)} style={{ padding: "5px 10px", background: "#0066cc", color: "#fff", border: "none", borderRadius: "5px", cursor: "pointer", fontSize: "11px" }}>Save</button>
                        <button onClick={() => setEomEditingNotesFor("")} style={{ padding: "5px 10px", background: "none", border: "1px solid #ddd", borderRadius: "5px", cursor: "pointer", fontSize: "11px" }}>Cancel</button>
                      </div>
                    ) : (
                      <div onClick={() => { setEomEditingNotesFor(t.taskId); setEomNotesDraft(t.clientNotes || ""); }}
                        style={{ marginTop: "6px", fontSize: "12px", color: t.clientNotes ? "#666" : "#bbb", cursor: "pointer" }}>
                        {t.clientNotes || "+ add note"}
                      </div>
                    )
                  )}
                </div>
              ))}
              {activeTasks.length === 0 && !eomClientTasksLoading && (
                <div style={{ padding: "20px", fontSize: "13px", color: "#999", textAlign: "center" }}>No tasks assigned yet — add one below.</div>
              )}
            </div>

            {inactiveTasks.length > 0 && (
              <details style={{ marginBottom: "16px", fontSize: "12px" }}>
                <summary style={{ cursor: "pointer", color: "#888" }}>{inactiveTasks.length} inactive task{inactiveTasks.length !== 1 ? "s" : ""}</summary>
                {inactiveTasks.map(t => (
                  <div key={t.taskId} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", color: "#aaa" }}>
                    <span>{t.name}</span>
                    <button onClick={() => handleEomToggleTaskActive(t)} style={{ background: "none", border: "none", color: "#0066cc", cursor: "pointer", fontSize: "11px" }}>Reactivate</button>
                  </div>
                ))}
              </details>
            )}

            <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "14px 18px" }}>
              {!eomAddTaskMode ? (
                <div style={{ display: "flex", gap: "8px" }}>
                  <button onClick={() => setEomAddTaskMode("template")} style={{ padding: "6px 12px", background: "#fff", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "12px" }}>+ Add from template library</button>
                  <button onClick={() => setEomAddTaskMode("custom")} style={{ padding: "6px 12px", background: "#fff", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "12px" }}>+ Add custom task</button>
                </div>
              ) : (
                <div>
                  {eomAddTaskMode === "template" ? (
                    eomCreatingNewTemplate ? (
                      <div style={{ display: "flex", gap: "8px", marginBottom: "8px" }}>
                        <input value={eomNewTemplateName} onChange={e => setEomNewTemplateName(e.target.value)} placeholder="New template name"
                          style={{ flex: 1, padding: "7px 10px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "13px", boxSizing: "border-box" }} />
                        <button onClick={() => { setEomCreatingNewTemplate(false); setEomNewTemplateName(""); }}
                          style={{ padding: "7px 10px", background: "none", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "12px" }}>
                          Pick existing instead
                        </button>
                      </div>
                    ) : (
                      <div style={{ marginBottom: "8px" }}>
                        <select value={eomNewTaskTemplateId} onChange={e => {
                            if (e.target.value === "__new__") { setEomCreatingNewTemplate(true); setEomNewTaskTemplateId(""); }
                            else setEomNewTaskTemplateId(e.target.value);
                          }}
                          style={{ width: "100%", padding: "7px 10px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "13px" }}>
                          <option value="">{eomTemplates === null ? "Loading templates..." : "Select a template..."}</option>
                          {(eomTemplates || []).filter(t => t.active).map(t => (
                            <option key={t.templateId} value={t.templateId}>{t.name}</option>
                          ))}
                          <option value="__new__">+ Create new template...</option>
                        </select>
                        {eomTemplatesError && (
                          <div style={{ fontSize: "11px", color: "#dc2626", marginTop: "4px" }}>
                            {eomTemplatesError} — <button onClick={reloadEomTemplatesForPicker} style={{ background: "none", border: "none", color: "#0066cc", cursor: "pointer", fontSize: "11px", padding: 0, textDecoration: "underline" }}>retry</button>
                          </div>
                        )}
                      </div>
                    )
                  ) : (
                    <input value={eomNewTaskName} onChange={e => setEomNewTaskName(e.target.value)} placeholder="Task name"
                      style={{ width: "100%", padding: "7px 10px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "13px", marginBottom: "8px", boxSizing: "border-box" }} />
                  )}
                  <input value={eomNewTaskNotes} onChange={e => setEomNewTaskNotes(e.target.value)} placeholder="Notes (optional)"
                    style={{ width: "100%", padding: "7px 10px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "13px", marginBottom: "10px", boxSizing: "border-box" }} />
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button disabled={eomAddTaskSaving} onClick={handleEomAddTask}
                      style={{ padding: "6px 14px", background: eomAddTaskSaving ? "#ccc" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: eomAddTaskSaving ? "default" : "pointer", fontSize: "12px", fontWeight: "600" }}>
                      {eomAddTaskSaving ? "Saving..." : "Add"}
                    </button>
                    <button onClick={() => { setEomAddTaskMode(""); setEomNewTaskTemplateId(""); setEomNewTaskName(""); setEomNewTaskNotes(""); setEomCreatingNewTemplate(false); setEomNewTemplateName(""); }}
                      style={{ padding: "6px 14px", background: "none", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "12px" }}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {eomSubView === "payroll" && (() => {
        const { files: payrollFiles, stillResolving, readyToStart, completeCount, errorCount } = toolsFileStats("payroll");
        return (<>
        <p style={{ margin: "0 0 20px", fontSize: "13px", color: "#666" }}>
          Payroll import — upload several clients&apos; payroll documents at once (PDF, image, or Excel). Each one is matched to a client automatically; anything it can&apos;t work out is flagged for you to assign.
        </p>

        <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "16px 20px", marginBottom: "20px" }}>
          <h3 style={{ margin: "0 0 14px", fontSize: "15px", fontWeight: "700" }}>Import Payroll</h3>

          <div style={{ marginBottom: "14px" }}>
            <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px", fontWeight: "600" }}>Payroll documents</label>
            <input type="file" multiple accept=".pdf,image/*,.xlsx,.xls,.csv"
              onChange={e => { handleToolsFilesSelect(e.target.files, "payroll"); e.target.value = ""; }}
              style={{ width: "100%", fontSize: "13px" }} />
          </div>

          {payrollFiles.length > 0 && (
            <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "6px", flexWrap: "wrap" }}>
              <button
                disabled={!readyToStart || toolsBatchRunning}
                onClick={startToolsBatch}
                style={{ padding: "8px 20px", background: (!readyToStart || toolsBatchRunning) ? "#ccc" : "#0066cc",
                  color: "#fff", border: "none", borderRadius: "6px",
                  cursor: (!readyToStart || toolsBatchRunning) ? "default" : "pointer", fontSize: "13px", fontWeight: "600" }}>
                {toolsBatchRunning ? <><Spinner color="#fff" /> Processing...</> : "Process All"}
              </button>
              <span style={{ fontSize: "12px", color: "#888" }}>
                {completeCount} of {payrollFiles.length} complete{errorCount > 0 ? ` · ${errorCount} error${errorCount !== 1 ? "s" : ""}` : ""}
              </span>
              {stillResolving.length > 0 && (
                <span style={{ fontSize: "12px", color: "#b45309" }}>
                  Waiting on {stillResolving.length} file{stillResolving.length !== 1 ? "s" : ""} to finish identifying before this can start
                </span>
              )}
            </div>
          )}
        </div>

        {payrollFiles.map(f => (
          <div key={f.id} style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "14px 18px", marginBottom: "14px" }}>
            <div style={{ fontSize: "14px", fontWeight: "700", color: "#1a1a1a", marginBottom: "8px" }}>{f.fileName}</div>

            {(f.convertStatus === "converting" || f.convertStatus === "pending") && (
              <div style={{ fontSize: "13px", color: "#666" }}><Spinner /> {f.convertMsg || "Preparing..."}</div>
            )}
            {f.convertStatus === "error" && (
              <div style={{ fontSize: "13px", color: "#dc2626" }}>{f.convertMsg}</div>
            )}

            {f.convertStatus === "ready" && (
              <>
                {f.detectStatus === "detecting" && (
                  <div style={{ fontSize: "13px", color: "#666", marginBottom: "8px" }}><Spinner /> Working out which client this belongs to...</div>
                )}
                {f.detectStatus === "matched" && f.processStatus === "pending" && (
                  <div style={{ fontSize: "13px", color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "6px", padding: "6px 10px", marginBottom: "8px" }}>
                    ✓ Detected client: <strong>{f.client}</strong>
                    {" "}<span style={{ color: "#888" }}>
                      ({f.detectMethod === "filename" ? "matched by filename" : f.detectMethod === "document_name" ? "matched by name on document" : "matched by employee names"})
                    </span>
                  </div>
                )}
                {f.detectStatus === "ambiguous" && f.processStatus === "pending" && (
                  <div style={{ fontSize: "13px", color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "6px", padding: "6px 10px", marginBottom: "8px" }}>
                    ⚠️ Couldn&apos;t work out the client automatically{f.ambiguousInfo?.error ? ` (${f.ambiguousInfo.error})` : ""} — please select it below.
                    {f.ambiguousInfo?.candidateScores?.length > 0 && (
                      <div style={{ marginTop: "4px", fontSize: "12px", color: "#92400e" }}>
                        Closest guesses: {f.ambiguousInfo.candidateScores.map(s => `${s.clientName} (${s.overlap} matching name${s.overlap !== 1 ? "s" : ""})`).join(", ")}
                      </div>
                    )}
                  </div>
                )}

                {f.processStatus === "pending" && (
                  <div style={{ marginBottom: "6px" }}>
                    <select value={f.client} onChange={e => updateToolsFile(f.id, { client: e.target.value })}
                      style={{ width: "100%", padding: "7px 10px", border: `1px solid ${f.detectStatus === "ambiguous" && !f.client ? "#fbbf24" : "#ddd"}`, borderRadius: "6px", fontSize: "13px", boxSizing: "border-box" }}>
                      <option value="">Select a client...</option>
                      {(allOutgoingsClients || []).map(c => (
                        <option key={c.clientName} value={c.clientName}>{c.clientName}</option>
                      ))}
                    </select>
                  </div>
                )}

                {f.processStatus === "processing" && (
                  <div style={{ fontSize: "13px", color: "#666" }}><Spinner /> {f.processMsg}</div>
                )}

                {f.processStatus === "confirm_period" && f.pendingConfirm && (
                  <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "6px", padding: "10px 12px" }}>
                    <div style={{ fontSize: "13px", fontWeight: "700", color: "#664d03", marginBottom: "6px" }}>Date not found</div>
                    <div style={{ fontSize: "13px", color: "#664d03", marginBottom: "10px" }}>
                      Would you like to apply this data to the most recent period: <strong>{f.pendingConfirm.fallback}</strong>?
                    </div>
                    <div style={{ display: "flex", gap: "10px" }}>
                      <button onClick={() => processOneToolsFile(f.id, f.pendingConfirm.fallback)}
                        style={{ padding: "6px 14px", background: "#198754", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>
                        Yes, apply
                      </button>
                      <button onClick={() => updateToolsFile(f.id, { processStatus: "error", pendingConfirm: null, processMsg: "Cancelled — please check the document and try again." })}
                        style={{ padding: "6px 14px", background: "#dc3545", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {f.processStatus === "error" && (
                  <div style={{ fontSize: "13px", color: "#dc2626" }}>{f.processMsg}</div>
                )}

                {f.processStatus === "complete" && f.result && (
                  <div>
                    <div style={{ fontSize: "13px", color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "6px", padding: "6px 10px", marginBottom: "12px" }}>
                      ✓ {f.client} — updated {f.result.updateCount} row{f.result.updateCount !== 1 ? "s" : ""} in column {f.result.startCol} for {f.result.targetMonthStr}
                    </div>

                    {f.result.totalsCheck && (
                      <div style={{ marginBottom: "12px" }}>
                        <div style={{ fontSize: "12px", fontWeight: "700", color: "#444", marginBottom: "6px" }}>
                          Totals check <span style={{ fontWeight: "400", color: "#888" }}>
                            ({f.result.totalsSource === "document" ? "from a totals row on the document" : "AI-calculated — no totals row found on the document"})
                          </span>
                        </div>
                        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "12px" }}>
                          <thead>
                            <tr style={{ borderBottom: "2px solid #e0e0e0" }}>
                              {["Category", "Document", "Written", "Diff", ""].map(h => (
                                <th key={h} style={{ padding: "5px 8px", textAlign: "left", fontWeight: "600", color: "#555" }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {f.result.totalsCheck.map(row => (
                              <tr key={row.category} style={{ borderBottom: "1px solid #f0f0f0" }}>
                                <td style={{ padding: "5px 8px" }}>{categoryLabels[row.category] || row.category}</td>
                                <td style={{ padding: "5px 8px" }}>£{row.documentTotal.toFixed(2)}</td>
                                <td style={{ padding: "5px 8px" }}>£{row.writtenTotal.toFixed(2)}</td>
                                <td style={{ padding: "5px 8px", color: row.reconciled ? "#166534" : "#dc2626" }}>£{row.diff.toFixed(2)}</td>
                                <td style={{ padding: "5px 8px" }}>{row.reconciled ? "✓" : "⚠️"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {f.result.newStarters?.length > 0 && (
                      <div style={{ marginBottom: "8px" }}>
                        <div style={{ fontSize: "12px", fontWeight: "700", color: "#dc2626", marginBottom: "4px" }}>🔴 In document, not in sheet:</div>
                        {f.result.newStarters.map((n, i) => <div key={i} style={{ fontSize: "12px", color: "#555" }}>{n}</div>)}
                      </div>
                    )}
                    {f.result.unmatched?.length > 0 && (
                      <div style={{ marginBottom: "8px" }}>
                        <div style={{ fontSize: "12px", fontWeight: "700", color: "#b45309", marginBottom: "4px" }}>⚠️ Unmatched:</div>
                        {f.result.unmatched.map((n, i) => <div key={i} style={{ fontSize: "12px", color: "#555" }}>{n}</div>)}
                      </div>
                    )}
                    {f.result.missingFromDoc?.length > 0 && (
                      <div>
                        <div style={{ fontSize: "12px", fontWeight: "700", color: "#888", marginBottom: "4px" }}>⚪ In sheet, missing from document:</div>
                        {f.result.missingFromDoc.map((n, i) => <div key={i} style={{ fontSize: "12px", color: "#555" }}>{n}</div>)}
                      </div>
                    )}
                    {!f.result.newStarters?.length && !f.result.unmatched?.length && !f.result.missingFromDoc?.length && (
                      <div style={{ fontSize: "12px", color: "#166534" }}>✓ Every employee matched cleanly — no discrepancies.</div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        </>);
      })()}

      {eomSubView === "time" && (() => {
        const { files: timeFiles, stillResolving, readyToStart, completeCount, errorCount } = toolsFileStats("time");
        return (<>
        <p style={{ margin: "0 0 20px", fontSize: "13px", color: "#666" }}>
          Time report import — upload several clients&apos; time tracking documents at once (PDF, image, or Excel). Each one is matched to a client automatically; anything it can&apos;t work out is flagged for you to assign.
        </p>

        <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "16px 20px", marginBottom: "20px" }}>
          <h3 style={{ margin: "0 0 14px", fontSize: "15px", fontWeight: "700" }}>Import Time Reports</h3>

          <div style={{ marginBottom: "14px" }}>
            <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px", fontWeight: "600" }}>Time report documents</label>
            <input type="file" multiple accept=".pdf,image/*,.xlsx,.xls,.csv"
              onChange={e => { handleToolsFilesSelect(e.target.files, "time"); e.target.value = ""; }}
              style={{ width: "100%", fontSize: "13px" }} />
          </div>

          {timeFiles.length > 0 && (
            <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "6px", flexWrap: "wrap" }}>
              <button
                disabled={!readyToStart || toolsBatchRunning}
                onClick={startToolsBatch}
                style={{ padding: "8px 20px", background: (!readyToStart || toolsBatchRunning) ? "#ccc" : "#0066cc",
                  color: "#fff", border: "none", borderRadius: "6px",
                  cursor: (!readyToStart || toolsBatchRunning) ? "default" : "pointer", fontSize: "13px", fontWeight: "600" }}>
                {toolsBatchRunning ? <><Spinner color="#fff" /> Processing...</> : "Process All"}
              </button>
              <span style={{ fontSize: "12px", color: "#888" }}>
                {completeCount} of {timeFiles.length} complete{errorCount > 0 ? ` · ${errorCount} error${errorCount !== 1 ? "s" : ""}` : ""}
              </span>
              {stillResolving.length > 0 && (
                <span style={{ fontSize: "12px", color: "#b45309" }}>
                  Waiting on {stillResolving.length} file{stillResolving.length !== 1 ? "s" : ""} to finish identifying before this can start
                </span>
              )}
            </div>
          )}
        </div>

        {timeFiles.map(f => (
          <div key={f.id} style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "14px 18px", marginBottom: "14px" }}>
            <div style={{ fontSize: "14px", fontWeight: "700", color: "#1a1a1a", marginBottom: "8px" }}>{f.fileName}</div>

            {(f.convertStatus === "converting" || f.convertStatus === "pending") && (
              <div style={{ fontSize: "13px", color: "#666" }}><Spinner /> {f.convertMsg || "Preparing..."}</div>
            )}
            {f.convertStatus === "error" && (
              <div style={{ fontSize: "13px", color: "#dc2626" }}>{f.convertMsg}</div>
            )}

            {f.convertStatus === "ready" && (
              <>
                {f.detectStatus === "detecting" && (
                  <div style={{ fontSize: "13px", color: "#666", marginBottom: "8px" }}><Spinner /> Working out which client this belongs to...</div>
                )}
                {f.detectStatus === "matched" && f.processStatus === "pending" && (
                  <div style={{ fontSize: "13px", color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "6px", padding: "6px 10px", marginBottom: "8px" }}>
                    ✓ Detected client: <strong>{f.client}</strong>
                    {" "}<span style={{ color: "#888" }}>
                      ({f.detectMethod === "filename" ? "matched by filename" : f.detectMethod === "document_name" ? "matched by name on document" : "matched by employee names"})
                    </span>
                  </div>
                )}
                {f.detectStatus === "ambiguous" && f.processStatus === "pending" && (
                  <div style={{ fontSize: "13px", color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "6px", padding: "6px 10px", marginBottom: "8px" }}>
                    ⚠️ Couldn&apos;t work out the client automatically{f.ambiguousInfo?.error ? ` (${f.ambiguousInfo.error})` : ""} — please select it below.
                    {f.ambiguousInfo?.candidateScores?.length > 0 && (
                      <div style={{ marginTop: "4px", fontSize: "12px", color: "#92400e" }}>
                        Closest guesses: {f.ambiguousInfo.candidateScores.map(s => `${s.clientName} (${s.overlap} matching name${s.overlap !== 1 ? "s" : ""})`).join(", ")}
                      </div>
                    )}
                  </div>
                )}

                {f.processStatus === "pending" && (
                  <div style={{ marginBottom: "6px" }}>
                    <select value={f.client} onChange={e => updateToolsFile(f.id, { client: e.target.value })}
                      style={{ width: "100%", padding: "7px 10px", border: `1px solid ${f.detectStatus === "ambiguous" && !f.client ? "#fbbf24" : "#ddd"}`, borderRadius: "6px", fontSize: "13px", boxSizing: "border-box" }}>
                      <option value="">Select a client...</option>
                      {(allOutgoingsClients || []).map(c => (
                        <option key={c.clientName} value={c.clientName}>{c.clientName}</option>
                      ))}
                    </select>
                  </div>
                )}

                {f.processStatus === "processing" && (
                  <div style={{ fontSize: "13px", color: "#666" }}><Spinner /> {f.processMsg}</div>
                )}

                {f.processStatus === "confirm_period" && f.pendingConfirm && (
                  <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: "6px", padding: "10px 12px" }}>
                    <div style={{ fontSize: "13px", fontWeight: "700", color: "#664d03", marginBottom: "6px" }}>Date not found</div>
                    <div style={{ fontSize: "13px", color: "#664d03", marginBottom: "10px" }}>
                      Would you like to apply this data to the most recent period: <strong>{f.pendingConfirm.fallback}</strong>?
                    </div>
                    <div style={{ display: "flex", gap: "10px" }}>
                      <button onClick={() => processOneToolsFile(f.id, f.pendingConfirm.fallback)}
                        style={{ padding: "6px 14px", background: "#198754", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>
                        Yes, apply
                      </button>
                      <button onClick={() => updateToolsFile(f.id, { processStatus: "error", pendingConfirm: null, processMsg: "Cancelled — please check the document and try again." })}
                        style={{ padding: "6px 14px", background: "#dc3545", color: "#fff", border: "none", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "600" }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {f.processStatus === "error" && (
                  <div style={{ fontSize: "13px", color: "#dc2626" }}>{f.processMsg}</div>
                )}

                {f.processStatus === "complete" && f.result && (
                  <div>
                    <div style={{ fontSize: "13px", color: "#166534", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: "6px", padding: "6px 10px", marginBottom: "12px" }}>
                      ✓ {f.client} — updated {f.result.updateCount} row{f.result.updateCount !== 1 ? "s" : ""} in column {f.result.startCol} for {f.result.targetMonthStr}
                    </div>

                    {f.result.newStarters?.length > 0 && (
                      <div style={{ marginBottom: "8px" }}>
                        <div style={{ fontSize: "12px", fontWeight: "700", color: "#dc2626", marginBottom: "4px" }}>🔴 In document, not in sheet:</div>
                        {f.result.newStarters.map((n, i) => <div key={i} style={{ fontSize: "12px", color: "#555" }}>{n}</div>)}
                      </div>
                    )}
                    {f.result.unmatched?.length > 0 && (
                      <div style={{ marginBottom: "8px" }}>
                        <div style={{ fontSize: "12px", fontWeight: "700", color: "#b45309", marginBottom: "4px" }}>⚠️ Unmatched:</div>
                        {f.result.unmatched.map((n, i) => <div key={i} style={{ fontSize: "12px", color: "#555" }}>{n}</div>)}
                      </div>
                    )}
                    {f.result.missingFromDoc?.length > 0 && (
                      <div>
                        <div style={{ fontSize: "12px", fontWeight: "700", color: "#888", marginBottom: "4px" }}>⚪ In sheet, missing from document:</div>
                        {f.result.missingFromDoc.map((n, i) => <div key={i} style={{ fontSize: "12px", color: "#555" }}>{n}</div>)}
                      </div>
                    )}
                    {!f.result.newStarters?.length && !f.result.unmatched?.length && !f.result.missingFromDoc?.length && (
                      <div style={{ fontSize: "12px", color: "#166534" }}>✓ Every employee matched cleanly — no discrepancies.</div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        </>);
      })()}

      {eomSubView === "cash" && (() => {
        const [y, m] = eomCashMonthKey.split("-").map(Number);
        const monthLabel = new Date(y, m - 1, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
        const shiftCashMonth = (delta) => {
          const d = new Date(y, m - 1 + delta, 1);
          setEomCashMonthKey(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
        };

        if (eomCashSubView === "list") {
          const remaining = eomCashEligibleClients.filter(c => !(eomCashCompletedClients || []).includes(c.clientName)).length;
          return (
            <div>
              <p style={{ margin: "0 0 16px", fontSize: "13px", color: "#666" }}>
                Enter each client&apos;s closing cash balance for the selected month. Account names are cached — use &quot;Load bank account information&quot; if they&apos;ve changed.
              </p>

              <div style={{ marginBottom: "16px" }}>
                <button onClick={handleLoadBankAccounts} disabled={eomBankAccountsLoading}
                  style={{ padding: "6px 14px", background: "#fff", border: "1px solid #ddd", borderRadius: "6px", cursor: eomBankAccountsLoading ? "default" : "pointer", fontSize: "12px", color: "#666" }}>
                  {eomBankAccountsLoading ? <><Spinner /> Loading...</> : "Load bank account information"}
                </button>
                {eomBankAccountsLoadedAt && (
                  <span style={{ marginLeft: "10px", fontSize: "11px", color: "#999" }}>
                    Last loaded {new Date(eomBankAccountsLoadedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}
                  </span>
                )}
                {eomBankAccountsLoadResult && (
                  eomBankAccountsLoadResult.error ? (
                    <div style={{ marginTop: "6px", fontSize: "12px", color: "#dc2626" }}>Load failed: {eomBankAccountsLoadResult.error}</div>
                  ) : (
                    <div style={{ marginTop: "6px", fontSize: "12px", color: "#166534" }}>
                      ✓ Loaded {eomBankAccountsLoadResult.accountsLoaded} account{eomBankAccountsLoadResult.accountsLoaded !== 1 ? "s" : ""} across {eomBankAccountsLoadResult.clientsProcessed} client{eomBankAccountsLoadResult.clientsProcessed !== 1 ? "s" : ""}
                      {eomBankAccountsLoadResult.failedClients?.length > 0 && (
                        <span style={{ color: "#b45309" }}> — couldn&apost read: {eomBankAccountsLoadResult.failedClients.join(", ")}</span>
                      )}
                    </div>
                  )
                )}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "16px" }}>
                <button onClick={() => shiftCashMonth(-1)} style={{ padding: "4px 10px", background: "none", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>‹</button>
                <div style={{ fontSize: "15px", fontWeight: "700", minWidth: "140px", textAlign: "center" }}>{monthLabel}</div>
                <button onClick={() => shiftCashMonth(1)} style={{ padding: "4px 10px", background: "none", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>›</button>
                {eomCashProgressLoading && <Spinner />}
              </div>

              <div style={{ marginBottom: "16px" }}>
                <button onClick={startCashFlow} disabled={remaining === 0}
                  style={{ padding: "8px 20px", background: remaining === 0 ? "#ccc" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: remaining === 0 ? "default" : "pointer", fontSize: "13px", fontWeight: "600" }}>
                  {remaining === 0 ? "All clients entered" : `Start entry (${remaining} remaining)`}
                </button>
              </div>

              <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", overflow: "hidden" }}>
                {eomCashEligibleClients.map((c, i) => {
                  const done = (eomCashCompletedClients || []).includes(c.clientName);
                  return (
                    <div key={c.clientName} onClick={() => selectSingleCashClient(c.clientName)}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 18px", borderTop: i > 0 ? "1px solid #f0f0f0" : "none", cursor: "pointer" }}>
                      <div style={{ fontSize: "13px", fontWeight: "600", color: "#1a1a1a" }}>{c.clientName}</div>
                      <div style={{ fontSize: "12px", color: done ? "#166534" : "#999" }}>{done ? "✓ Entered" : "Not yet entered"}</div>
                    </div>
                  );
                })}
                {eomCashEligibleClients.length === 0 && (
                  <div style={{ padding: "20px", fontSize: "13px", color: "#999", textAlign: "center" }}>No clients with an active &quot;Cash Balance&quot; task found.</div>
                )}
              </div>
            </div>
          );
        }

        const accounts = Object.keys(eomCashEntryAmounts);
        const isFlow = eomCashSubView === "flow";
        return (
          <div>
            <button onClick={() => setEomCashSubView("list")}
              style={{ background: "none", border: "none", color: "#0066cc", cursor: "pointer", fontSize: "13px", padding: "0 0 12px", display: "block" }}>
              ‹ Back to list
            </button>

            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
              <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "700" }}>{eomCashEntryClient}</h3>
              {isFlow && <span style={{ fontSize: "12px", color: "#888" }}>({eomCashFlowIndex + 1} of {eomCashFlowQueue.length})</span>}
            </div>
            <div style={{ fontSize: "12px", color: "#888", marginBottom: "16px" }}>Closing balance for {monthLabel}</div>

            <div style={{ background: "#fff", borderRadius: "10px", border: "1px solid #e0e0e0", padding: "16px 20px", marginBottom: "16px" }}>
              {accounts.map(accountName => (
                <div key={accountName} style={{ marginBottom: "10px" }}>
                  <label style={{ fontSize: "12px", color: "#666", display: "block", marginBottom: "4px", fontWeight: "600" }}>{accountName}</label>
                  <input type="number" step="0.01" value={eomCashEntryAmounts[accountName]}
                    onChange={e => setEomCashEntryAmounts(prev => ({ ...prev, [accountName]: e.target.value }))}
                    placeholder="0.00"
                    style={{ width: "100%", padding: "8px 10px", border: "1px solid #ddd", borderRadius: "6px", fontSize: "14px", boxSizing: "border-box" }} />
                </div>
              ))}
            </div>

            {eomCashSaveStatus === "error" && <div style={{ color: "#dc2626", fontSize: "13px", marginBottom: "12px" }}>{eomCashSaveError}</div>}

            <div style={{ display: "flex", gap: "10px" }}>
              <button disabled={eomCashSaveStatus === "saving"} onClick={handleCashSave}
                style={{ padding: "8px 20px", background: eomCashSaveStatus === "saving" ? "#ccc" : "#0066cc", color: "#fff", border: "none", borderRadius: "6px", cursor: eomCashSaveStatus === "saving" ? "default" : "pointer", fontSize: "13px", fontWeight: "600" }}>
                {eomCashSaveStatus === "saving" ? "Saving..." : "Save" + (isFlow ? " and continue" : "")}
              </button>
              {isFlow && (
                <button onClick={handleCashSkip} disabled={eomCashSaveStatus === "saving"}
                  style={{ padding: "8px 16px", background: "none", border: "1px solid #ddd", borderRadius: "6px", cursor: "pointer", fontSize: "13px" }}>
                  Skip
                </button>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}