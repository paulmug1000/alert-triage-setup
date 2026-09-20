import { useState, useRef, useMemo } from "react";

function eomWorkMonthToTargetMonth(workMonthKey) {
  const [y, m] = String(workMonthKey || "").split("-").map(Number);
  if (!y || !m) return null;
  const d = new Date(y, m - 1 - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function useEoM(sessionId) {
  const [eomMonthKey, setEomMonthKey] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [eomAllTasks, setEomAllTasks] = useState(null);
  const [eomStatusOverrides, setEomStatusOverrides] = useState(null);
  const [eomStatusLoading, setEomStatusLoading] = useState(false);
  const [eomStatusError, setEomStatusError] = useState("");
  const [eomDetailClient, setEomDetailClient] = useState(null);
  const [eomClientTasksLoading, setEomClientTasksLoading] = useState(false);
  const [eomClientTasksError, setEomClientTasksError] = useState("");
  const [eomTemplates, setEomTemplates] = useState(null);
  const [eomTemplatesError, setEomTemplatesError] = useState("");
  const [eomAddTaskMode, setEomAddTaskMode] = useState("");
  const [eomNewTaskTemplateId, setEomNewTaskTemplateId] = useState("");
  const [eomNewTaskName, setEomNewTaskName] = useState("");
  const [eomNewTaskNotes, setEomNewTaskNotes] = useState("");
  const [eomAddTaskSaving, setEomAddTaskSaving] = useState(false);
  const [eomEditingNotesFor, setEomEditingNotesFor] = useState("");
  const [eomEditingNameFor, setEomEditingNameFor] = useState("");
  const [eomDeactivateConfirm, setEomDeactivateConfirm] = useState(null);
  const [eomNameDraft, setEomNameDraft] = useState("");
  const [eomExpandedNotesFor, setEomExpandedNotesFor] = useState(() => new Set());
  const [eomNotesDraft, setEomNotesDraft] = useState("");
  const [eomEditingNotelet, setEomEditingNotelet] = useState(null);
  const [eomNoteletDraft, setEomNoteletDraft] = useState("");
  const [eomNoteletSaving, setEomNoteletSaving] = useState(false);
  const [eomDraggedTaskId, setEomDraggedTaskId] = useState(null);
  const [eomShowTemplateManager, setEomShowTemplateManager] = useState(false);
  const [eomClientSettings, setEomClientSettings] = useState(null);
  const [eomShowExcludedManager, setEomShowExcludedManager] = useState(false);
  const [eomManagerTemplates, setEomManagerTemplates] = useState(null);
  const [eomManagerClientTasks, setEomManagerClientTasks] = useState(null);
  const [eomManagerLoading, setEomManagerLoading] = useState(false);
  const [eomManagerError, setEomManagerError] = useState("");
  const [eomEditingTemplateId, setEomEditingTemplateId] = useState("");
  const [eomTemplateDraft, setEomTemplateDraft] = useState({ name: "", defaultNotes: "", linkedFunction: "", active: true, alertCategories: "" });
  const [eomAddingNewTemplate, setEomAddingNewTemplate] = useState(false);
  const [eomNewTplName, setEomNewTplName] = useState("");
  const [eomNewTplNotes, setEomNewTplNotes] = useState("");
  const [eomNewTplLinkedFunction, setEomNewTplLinkedFunction] = useState("");
  const [eomNewTplAlertCategories, setEomNewTplAlertCategories] = useState("");
  const [eomAddingNewTemplateSaving, setEomAddingNewTemplateSaving] = useState(false);
  const [eomCashSubView, setEomCashSubView] = useState("list");
  const [eomCashMonthKey, setEomCashMonthKey] = useState(() => {
    const now = new Date();
    const currentWorkMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    return eomWorkMonthToTargetMonth(currentWorkMonthKey);
  });
  const [eomBankAccountsByClient, setEomBankAccountsByClient] = useState(null);
  const [eomBankAccountsLoadedAt, setEomBankAccountsLoadedAt] = useState("");
  const [eomBankAccountsLoading, setEomBankAccountsLoading] = useState(false);
  const [eomBankAccountsLoadResult, setEomBankAccountsLoadResult] = useState(null);
  const [eomCashCompletedClients, setEomCashCompletedClients] = useState(null);
  const [eomCashProgressLoading, setEomCashProgressLoading] = useState(false);
  const [eomCashFlowQueue, setEomCashFlowQueue] = useState([]);
  const [eomCashFlowIndex, setEomCashFlowIndex] = useState(0);
  const [eomCashEntryClient, setEomCashEntryClient] = useState("");
  const [eomCashEntryAmounts, setEomCashEntryAmounts] = useState({});
  const [eomCashSaveStatus, setEomCashSaveStatus] = useState("idle");
  const [eomCashSaveError, setEomCashSaveError] = useState("");
  const [eomMarkActualRunning, setEomMarkActualRunning] = useState("");
  const [eomBackupRunning, setEomBackupRunning] = useState("");
  const [eomAlertDataReady, setEomAlertDataReady] = useState(!!sessionId);
  const eomStatusQueueRef = useRef([]);
  const eomStatusTimerRef = useRef(null);
  const [eomCashPendingClient, setEomCashPendingClient] = useState("");
  const [eomDragOverTaskId, setEomDragOverTaskId] = useState(null);
  const [eomDraggedTemplateId, setEomDraggedTemplateId] = useState(null);
  const [eomDraggedClientName, setEomDraggedClientName] = useState(null);
  const [eomDragOverClientName, setEomDragOverClientName] = useState(null);
  const [eomDragOverTemplateId, setEomDragOverTemplateId] = useState(null);
  const [eomCreatingNewTemplate, setEomCreatingNewTemplate] = useState(false);
  const [eomNewTemplateName, setEomNewTemplateName] = useState("");

  const eomClientTasks = useMemo(() => (eomAllTasks || []).filter(t => t.clientName === eomDetailClient), [eomAllTasks, eomDetailClient]);

  return {
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
  };
}