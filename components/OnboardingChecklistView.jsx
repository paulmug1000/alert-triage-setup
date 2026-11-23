import React, { useState, useEffect, useCallback, useRef } from "react";
import Spinner from "./Spinner";
import KeyInfoSettingsForm from "./KeyInfoSettingsForm";
import AccountingSettingsSuggestionModal from "./setup/AccountingSettingsSuggestionModal";
import CategoryMappingSuggestionModal from "./setup/CategoryMappingSuggestionModal";
import CrmMappingSuggestionModal from "./setup/CrmMappingSuggestionModal";
import MatchCrmPipelineModal from "./setup/MatchCrmPipelineModal";
import ManualCategoryTrackingPanel from "./setup/ManualCategoryTrackingPanel";
import Year0SetupModal from "./setup/Year0SetupModal";
import InitialInvoiceSetupModal from "./setup/InitialInvoiceSetupModal";
import StarterPlModal from "./setup/StarterPlModal";
import CreateBudgetModal from "./setup/CreateBudgetModal";
import SelectBankAccountsModal from "./setup/SelectBankAccountsModal";
import CashOpeningModal from "./setup/CashOpeningModal";
import InitialTaxPaymentsModal from "./setup/InitialTaxPaymentsModal";
import SetupAutomationFlagsPanel from "./setup/SetupAutomationFlagsPanel";
import { buildConnectionEmailContent } from "../utils/helpers";

const FINAL_DATA_CAPTURE_ITEMS = [
  {
    key: "payroll_info",
    label: "Payroll info - including full staff list with salaries, plus payroll summary for previous period",
  },
  {
    key: "contractor_info",
    label: "Contractor info - including whether they are regular etc",
  },
  {
    key: "cash_opening",
    label: "Confirming cash opening balance for previous / current month",
  },
  {
    key: "delivery_pct",
    label: "Delivery % for all staff, including directors",
  },
  {
    key: "initial_tax_bills",
    label: "Confirming initial corp tax and VAT bills",
  },
];

function parseFinalDataCaptureMetadata(rawMeta) {
  if (!rawMeta || typeof rawMeta !== "string") return { items: {} };
  const trimmed = rawMeta.trim();
  if (!trimmed.startsWith("{")) return { items: {} };
  try {
    const parsed = JSON.parse(trimmed);
    return {
      items: parsed?.items && typeof parsed.items === "object" ? parsed.items : {},
    };
  } catch {
    return { items: {} };
  }
}

function formatTaskMetadataSummary(rawMeta) {
  if (!rawMeta) return "";
  const trimmed = String(rawMeta).trim();
  if (!trimmed.startsWith("{")) return trimmed;
  const parsed = parseFinalDataCaptureMetadata(trimmed);
  const doneCount = FINAL_DATA_CAPTURE_ITEMS.filter((it) => Boolean(parsed.items?.[it.key])).length;
  return `${doneCount} of ${FINAL_DATA_CAPTURE_ITEMS.length} items received and actioned`;
}

export default function OnboardingChecklistView({
  clientName,
  masterSheetId,
  clientSheetId,
  user,
  onOpenSheetEditor,
  onGoToBudget,
  onGoToTasks,
  onSetupModeToggled,
  onClientsChanged
}) {
  const isUserAdmin = Boolean(
    !user?.isReadOnly && (user?.isAdmin || user?.role === "Admin") && user?.role !== "ClientManager"
  );

  const [loading, setLoading] = useState(true);
  const [checklist, setChecklist] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [openPhaseId, setOpenPhaseId] = useState("");
  const [expandedTaskIds, setExpandedTaskIds] = useState({});
  const initialPhaseSetForClientRef = useRef("");

  useEffect(() => {
    if (!isUserAdmin && openPhaseId === "phase_1") {
      setOpenPhaseId("phase_2");
    }
  }, [isUserAdmin, openPhaseId]);

  // Automated Suggestions Modals state
  const [showAccountingModal, setShowAccountingModal] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [showCrmModal, setShowCrmModal] = useState(false);
  const [showCrmMatchModal, setShowCrmMatchModal] = useState(false);
  const [showYear0Modal, setShowYear0Modal] = useState(false);
  const [showInitialInvoicesModal, setShowInitialInvoicesModal] = useState(false);
  const [showStarterPlModal, setShowStarterPlModal] = useState(false);
  const [showCreateBudgetModal, setShowCreateBudgetModal] = useState(false);
  const [showSelectBankAccountsModal, setShowSelectBankAccountsModal] = useState(false);
  const [showCashOpeningModal, setShowCashOpeningModal] = useState(false);
  const [showInitialTaxModal, setShowInitialTaxModal] = useState(false);

  // Script IDs form state
  const [clientScriptId, setClientScriptId] = useState("");
  const [masterScriptId, setMasterScriptId] = useState("");
  const [reconScriptId, setReconScriptId] = useState("");
  const [savingScriptIds, setSavingScriptIds] = useState(false);

  // Deployment URL form state
  const [deploymentUrl, setDeploymentUrl] = useState("");
  const [savingDeploymentUrl, setSavingDeploymentUrl] = useState(false);

  // Completing setup & Stage 4 controls
  const [completingSetup, setCompletingSetup] = useState(false);
  const [makingPulseLive, setMakingPulseLive] = useState(false);
  const [savingCaptureItemKey, setSavingCaptureItemKey] = useState("");
  const [copiedGoLiveEmail, setCopiedGoLiveEmail] = useState(false);

  // Step 1 tool confirmation & connection-request email state
  const [toolAcc, setToolAcc] = useState("None");
  const [toolCrm, setToolCrm] = useState("None");
  const [toolCrmDrives, setToolCrmDrives] = useState("NA");
  const [confirmingTools, setConfirmingTools] = useState(false);

  const [inviteContacts, setInviteContacts] = useState([]);
  const [inviteEmailTo, setInviteEmailTo] = useState("");
  const [inviteContactName, setInviteContactName] = useState("");
  const [inviteEmailSubject, setInviteEmailSubject] = useState("");
  const [inviteEmailBody, setInviteEmailBody] = useState("");
  const [inviteBodyDirty, setInviteBodyDirty] = useState(false);
  const [sendingInviteEmail, setSendingInviteEmail] = useState(false);
  const loadedContactsClientRef = useRef("");

  const formatPhaseTitle = (title, displayStepNum = null) => {
    if (!title) return title;
    let raw = String(title);
    if (!isUserAdmin) {
      raw = raw.replace(/Infrastructure & Sheet Linking/gi, "System provisioning & initialisation");
    }
    if (displayStepNum !== null && displayStepNum !== undefined) {
      const withoutPrefix = raw.replace(/^Step\s+\d+\s*:\s*/i, "");
      return `Step ${displayStepNum}: ${withoutPrefix}`;
    }
    return raw;
  };

  const formatPhaseDescription = (desc) => {
    if (isUserAdmin || !desc) return desc;
    return String(desc)
      .replace(/Drive folder provisioning, template duplication, cross-linking, and script deployment\./gi, "Client workspace provisioning and system initialisation.")
      .replace(/and financial KeyInfo anchors\./gi, "and core financial settings.");
  };

  const formatTaskTitle = (task) => {
    const title = task?.title || "";
    if (isUserAdmin || !title) return title;
    if (task?.id === "p2_connect_accounting" || task?.id === "p2_connect_crm" || task?.waitingOnClient) {
      return title;
    }
    const nonAdminMap = {
      p1_drive_folder: "Create client workspace folder",
      p1_duplicate_templates: "Provision client financial models",
      p1_bookmarks: "Configure workspace shortcuts",
      p1_importrange_auth: "Authorise internal data sync connections",
      p1_agent_secret: "Configure automation security credentials",
      p1_gas_deployment: "Deploy background sync service",
      p1_rename_gas: "Configure background sync service identifiers",
      p1_script_ids: "Register client in system version tracker",
      p2_confirm_tools: "Confirm accounting and CRM tools",
      p2_request_connections_email: "Email client to request connections",
      p2_connect_accounting: "Awaiting client connection to accounting tool",
      p2_connect_crm: "Awaiting client connection to CRM tool",
      p2_keyinfo_settings: "Adjust core financial settings (Start date, VAT, PAYE, Revenue focus, Profit share %, Invoice formatting, Automation cadences)",
      p3_chart_of_accounts: "Pull Chart of Accounts and select manual categories",
      p3_pull_pl: "Pull P&L and assign accounts to categories",
      p3_year0_setup: "Check Year 0 setup, adding dividends in lieu of salary as required",
      p3_sync_invoices: "Initial job setup from invoices sent",
      p3_starter_pl: "Set up initial P&L and forecast",
      p3_other_expenses: "Create budget",
      p3_select_bank_accounts: "Select bank accounts",
      p3_cash_opening: "Add cash opening figure",
      p3_initial_tax_payments: "Update initial tax payment amounts",
      p4_crm_list_tab: "Set up CRM field mappings and Confirmed & Pipeline definitions",
      p4_ac_enrollment: "Enrol client in automated sync scheduler",
      p4_datachg_flags: "Configure automated alert flags as required",
      p4_rep_control: "Enrol client in month-end reporting",
      p5_make_live: "Make Pulse live",
      p5_email_client: "Email client saying Pulse is live and requesting further information"
    };
    if (task?.id && nonAdminMap[task.id]) return nonAdminMap[task.id];
    return String(title)
      .replace(/\s*\(KeyInfo[^)]*\)/gi, "")
      .replace(/\s+in KeyInfo\b[^)]*/gi, "")
      .replace(/\binto Outgoings tab\b/gi, "into Outgoings")
      .replace(/\bto Outgoings tab\b/gi, "to Outgoings")
      .replace(/\bCRMList tab\b/gi, "CRM configuration")
      .replace(/\bDataChgAlert\s*tab\b/gi, "automation settings")
      .replace(/\bMaster sheet\b/gi, "Pulse")
      .replace(/\s+sheet\b/gi, "");
  };

  // Toggle expansion of a single task's attached box
  const toggleTaskExpanded = (taskId) => {
    setExpandedTaskIds((prev) => ({
      ...prev,
      [taskId]: !prev[taskId]
    }));
  };
  // Determine whether a task has an expandable action box / details panel
  const hasTaskAttachment = useCallback(
    (task) => {
      if (!task) return false;
      if (isUserAdmin && ["p1_importrange_auth", "p1_gas_deployment", "p1_script_ids"].includes(task.id)) {
        return true;
      }
      if (["p2_confirm_tools", "p2_request_connections_email", "p2_keyinfo_settings", "p4_datachg_flags", "p3_chart_of_accounts", "p3_pull_pl", "p3_year0_setup", "p3_sync_invoices", "p3_starter_pl", "p3_other_expenses", "p3_select_bank_accounts", "p3_cash_opening", "p3_initial_tax_payments", "p4_review_crm", "p4_crm_list_tab", "p5_make_live", "p5_email_client"].includes(task.id)) {
        return true;
      }
      if (task.description && String(task.description).trim()) {
        return true;
      }
      return false;
    },
    [isUserAdmin]
  );

  // Collapse the completed task and auto-expand the next task in the phase if it has an attached box
  const advanceTaskExpansion = useCallback(
    (completedTaskId, phasesList) => {
      const activePhases = phasesList || checklist?.phases || [];
      setExpandedTaskIds((prev) => {
        const next = { ...prev, [completedTaskId]: false };
        for (const phase of activePhases) {
          const tasks = phase.tasks || [];
          const idx = tasks.findIndex((t) => t.id === completedTaskId);
          if (idx !== -1) {
            // Look for the immediately following task, or the next incomplete task in this phase
            for (let i = idx + 1; i < tasks.length; i++) {
              const candidate = tasks[i];
              if (!candidate.isCompleted) {
                if (hasTaskAttachment(candidate)) {
                  next[candidate.id] = true;
                }
                break;
              }
            }
            break;
          }
        }
        return next;
      });
    },
    [checklist?.phases, hasTaskAttachment]
  );

  // Load checklist data
  const loadChecklist = useCallback(async () => {
    if (!clientName) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/setup/checklist?clientName=${encodeURIComponent(clientName)}&masterSheetId=${encodeURIComponent(masterSheetId || "")}`);
      const data = await res.json();
      if (data.success) {
        setChecklist(data);
        if (data.config) {
          setToolAcc(data.config.accountingTool || "None");
          setToolCrm(data.config.crmTool || "None");
          setToolCrmDrives(data.config.crmDrives || "NA");
        }
        if (data.deploymentUrl || data.keyInfoSettings?.masterDeploymentUrl) {
          setDeploymentUrl(data.deploymentUrl || data.keyInfoSettings.masterDeploymentUrl);
        }
        if (data.scriptIds) {
          setClientScriptId(data.scriptIds.clientScriptId || "");
          setMasterScriptId(data.scriptIds.masterScriptId || "");
          setReconScriptId(data.scriptIds.reconScriptId || "");
        }
        if (Array.isArray(data.phases) && data.phases.length > 0) {
          const clientInitKey = `${clientName}::${isUserAdmin ? 1 : 0}`;
          const visibleOnLoad = data.phases.filter((p) => isUserAdmin || (p.id !== "phase_1" && !p.adminOnly));
          if (initialPhaseSetForClientRef.current !== clientInitKey) {
            initialPhaseSetForClientRef.current = clientInitKey;
            const firstIncomplete = visibleOnLoad.find((p) => !p.isPhaseComplete);
            setOpenPhaseId(firstIncomplete ? firstIncomplete.id : "");
          } else {
            setOpenPhaseId((prev) => {
              if (prev === "") return "";
              const exists = visibleOnLoad.some((p) => p.id === prev);
              if (exists) return prev;
              const firstIncomplete = visibleOnLoad.find((p) => !p.isPhaseComplete);
              return firstIncomplete ? firstIncomplete.id : "";
            });
          }
        }
      } else {
        throw new Error(data.error || "Failed to load onboarding checklist.");
      }
    } catch (err) {
      console.error("loadChecklist error:", err);
      setFeedback({ type: "error", message: err.message });
    } finally {
      setLoading(false);
    }
  }, [clientName, masterSheetId, isUserAdmin]);

  useEffect(() => {
    loadChecklist();
  }, [loadChecklist]);

  // Shared optimistic update helper (re-sums phase & total counts to prevent double-counting)
  const applyOptimisticTaskStatus = useCallback((taskId, newStatus) => {
    setChecklist((prev) => {
      if (!prev?.phases) return prev;
      let totalCompleted = 0;
      let totalTasks = 0;
      const newPhases = prev.phases.map((p) => {
        const tasks = (p.tasks || []).map((t) => (t.id === taskId ? { ...t, isCompleted: newStatus } : t));
        const phaseComp = tasks.filter((t) => t.isCompleted).length;
        totalCompleted += phaseComp;
        totalTasks += tasks.length;
        return {
          ...p,
          completedCount: phaseComp,
          isPhaseComplete: tasks.length > 0 && phaseComp === tasks.length,
          tasks
        };
      });
      return {
        ...prev,
        totalTasks: totalTasks || prev.totalTasks,
        completedCount: totalCompleted,
        progressPercent: totalTasks > 0 ? Math.round((totalCompleted / totalTasks) * 100) : 0,
        phases: newPhases
      };
    });
  }, []);

  // Handle task checkbox toggle
  const handleToggleTask = async (task) => {
    const newStatus = !task.isCompleted;
    setFeedback(null);

    if (newStatus) {
      advanceTaskExpansion(task.id, checklist?.phases);
    }

    applyOptimisticTaskStatus(task.id, newStatus);

    try {
      const res = await fetch("/api/setup/checklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId: masterSheetId || "",
          taskId: task.id,
          isCompleted: newStatus,
          ...(task.metadata ? { metadata: task.metadata } : {})
        })
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to update task.");
      }
    } catch (err) {
      console.error("Error updating task:", err);
      setFeedback({ type: "error", message: `Failed to update task: ${err.message}` });
      loadChecklist(); // Revert on error
    }
  };

  // Helper to mark a checklist task completed automatically (e.g. after suggestions applied)
  const handleAutoCompleteTask = async (taskId) => {
    advanceTaskExpansion(taskId, checklist?.phases);
    applyOptimisticTaskStatus(taskId, true);

    try {
      const res = await fetch("/api/setup/checklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId: masterSheetId || "",
          taskId,
          isCompleted: true
        })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to persist task completion.");
      }
      if (Array.isArray(data.phases)) {
        setChecklist((prev) => (prev ? { ...prev, ...data } : data));
      }
    } catch (err) {
      console.warn("Could not auto-complete task:", err.message);
      loadChecklist(); // Revert optimistic update on failure
    }
  };

  const effectiveClientMode = checklist?.clientMode || "sheet";
  const effectiveMasterMode = checklist?.masterMode || "sheet";
  const showClientScriptInput = effectiveClientMode === "sheet";
  const showMasterScriptInputs = effectiveMasterMode === "sheet";
  const effectiveClientSheetId = checklist?.clientSheetId || clientSheetId;
  const effectiveMasterSheetId = checklist?.masterSheetId || masterSheetId;

  // Save Script IDs
  const handleSaveScriptIds = async (e) => {
    e?.preventDefault();
    const hasRelevantId =
      (showClientScriptInput && clientScriptId.trim()) ||
      (showMasterScriptInputs && (masterScriptId.trim() || reconScriptId.trim()));
    if (!hasRelevantId) {
      setFeedback({ type: "error", message: "Please enter at least one script ID." });
      return;
    }
    setSavingScriptIds(true);
    setFeedback(null);

    try {
      const payload = { clientName };
      if (showClientScriptInput) payload.clientScriptId = clientScriptId.trim();
      if (showMasterScriptInputs) {
        payload.masterScriptId = masterScriptId.trim();
        payload.reconScriptId = reconScriptId.trim();
      }
      const res = await fetch("/api/setup/script-ids", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({
          type: "success",
          message: data.rowNum
            ? `Script IDs recorded into version tracker (row ${data.rowNum}).`
            : "Script IDs saved."
        });
        advanceTaskExpansion("p1_script_ids", checklist?.phases);
        loadChecklist();
      } else {
        throw new Error(data.error || "Failed to save script IDs.");
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSavingScriptIds(false);
    }
  };

  // Save Master GAS Deployment URL
  const handleSaveDeploymentUrl = async (e) => {
    e?.preventDefault();
    if (!deploymentUrl.trim()) {
      setFeedback({ type: "error", message: "Please paste a deployment URL or ID." });
      return;
    }
    setSavingDeploymentUrl(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/setup/deployment-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId,
          deploymentUrl: deploymentUrl.trim()
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "success", message: "Master GAS deployment URL saved to KeyInfo!X29 and tracker sheet." });
        advanceTaskExpansion("p1_gas_deployment", checklist?.phases);
        loadChecklist();
      } else {
        throw new Error(data.error || "Failed to save deployment URL.");
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSavingDeploymentUrl(false);
    }
  };

  // Make Pulse live while leaving client in setup mode
  const handleMakePulseLive = async () => {
    setMakingPulseLive(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId,
          setupMode: true,
          pulseLive: true,
          requestConnections: false,
          accountingTool: checklist?.config?.accountingTool || "None",
          crmTool: checklist?.config?.crmTool || "None",
          crmDrives: checklist?.config?.crmDrives || "NA"
        })
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to make Pulse live.");
      }
      setChecklist((prev) =>
        prev
          ? {
            ...prev,
            pulseLive: true,
            config: data.config || { ...(prev.config || {}), pulseLive: true, requestConnections: false }
          }
          : prev
      );
      await handleAutoCompleteTask("p5_make_live");
      setFeedback({
        type: "success",
        message: "Pulse is now live for client users and scheduled automations, while setup mode remains active."
      });
      if (onSetupModeToggled) onSetupModeToggled({ setupMode: true, pulseLive: true });
      if (onClientsChanged) onClientsChanged();
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setMakingPulseLive(false);
    }
  };

  // Toggle one of the 5 final data capture sub-checkboxes inside Stage 4 Task 2
  const handleToggleFinalCaptureItem = async (task, itemKey) => {
    const current = parseFinalDataCaptureMetadata(task?.metadata);
    const nextItems = {
      ...current.items,
      [itemKey]: !current.items?.[itemKey],
    };
    const nextMetadataStr = JSON.stringify({ items: nextItems });
    const allChecked = FINAL_DATA_CAPTURE_ITEMS.every((it) => Boolean(nextItems[it.key]));
    const nextIsCompleted = allChecked ? true : Boolean(task?.isCompleted);

    setSavingCaptureItemKey(itemKey);
    setFeedback(null);

    // Optimistic update preserving metadata + updating completion if all 5 checked
    setChecklist((prev) => {
      if (!prev?.phases) return prev;
      let totalCompleted = 0;
      let totalTasks = 0;
      const newPhases = prev.phases.map((p) => {
        const tasks = (p.tasks || []).map((t) =>
          t.id === task.id ? { ...t, metadata: nextMetadataStr, isCompleted: nextIsCompleted } : t
        );
        const phaseComp = tasks.filter((t) => t.isCompleted).length;
        totalCompleted += phaseComp;
        totalTasks += tasks.length;
        return {
          ...p,
          completedCount: phaseComp,
          isPhaseComplete: tasks.length > 0 && phaseComp === tasks.length,
          tasks,
        };
      });
      return {
        ...prev,
        totalTasks: totalTasks || prev.totalTasks,
        completedCount: totalCompleted,
        progressPercent: totalTasks > 0 ? Math.round((totalCompleted / totalTasks) * 100) : 0,
        phases: newPhases,
      };
    });

    try {
      const res = await fetch("/api/setup/checklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId: masterSheetId || "",
          taskId: task.id,
          isCompleted: nextIsCompleted,
          metadata: nextMetadataStr,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to save item status.");
      }
      if (Array.isArray(data.phases)) {
        setChecklist((prev) => (prev ? { ...prev, ...data } : data));
      }
    } catch (err) {
      setFeedback({ type: "error", message: `Failed to save checklist item: ${err.message}` });
      loadChecklist();
    } finally {
      setSavingCaptureItemKey("");
    }
  };

  const handleCopyGoLiveEmail = async () => {
    const text = [
      `Hi there,`,
      ``,
      `Pulse is now live for ${clientName}. You can log in at https://app.pulsedashboard.co.uk/ using the Microsoft or Google buttons as before.`,
      ``,
      `There are a few remaining items needed to ensure the details in Pulse are as accurate as possible. Could you please share / confirm:`,
      ``,
      ...FINAL_DATA_CAPTURE_ITEMS.map((it) => `- ${it.label}`),
      ``,
      `Thanks,`
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopiedGoLiveEmail(true);
      setTimeout(() => setCopiedGoLiveEmail(false), 2500);
    } catch {
      setFeedback({ type: "error", message: "Could not copy email draft to clipboard." });
    }
  };

  // Load assigned client contacts to prefill the connection-request email draft
  useEffect(() => {
    if (!clientName) return;
    if (loadedContactsClientRef.current === clientName) return;
    loadedContactsClientRef.current = clientName;
    setInviteBodyDirty(false);
    setInviteContacts([]);
    setInviteEmailTo("");
    setInviteContactName("");

    fetch(`/api/setup/client-invite?clientName=${encodeURIComponent(clientName)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.success && Array.isArray(d.contacts) && d.contacts.length > 0) {
          setInviteContacts(d.contacts);
          setInviteEmailTo(d.contacts[0].email || "");
          setInviteContactName(d.contacts[0].name || "");
        }
      })
      .catch(() => { });
  }, [clientName]);

  // Keep default email subject/body synced with confirmed tools & contact until manually edited
  useEffect(() => {
    if (inviteBodyDirty) return;
    const draft = buildConnectionEmailContent({
      contactName: inviteContactName,
      accountingTool: checklist?.config?.accountingTool || toolAcc,
      crmTool: checklist?.config?.crmTool || toolCrm,
    });
    setInviteEmailSubject(draft.subject);
    setInviteEmailBody(draft.body);
  }, [inviteBodyDirty, inviteContactName, checklist?.config?.accountingTool, checklist?.config?.crmTool, toolAcc, toolCrm]);

  // Step 1 Task 1: Confirm accounting & CRM tools selected during provisioning
  const handleConfirmTools = async (e) => {
    e?.preventDefault();
    setConfirmingTools(true);
    setFeedback(null);
    try {
      const nextDrives = toolCrm === "None" ? "NA" : (toolCrmDrives || "NA");
      const res = await fetch("/api/setup/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId: effectiveMasterSheetId || "",
          setupMode: checklist?.setupMode ?? true,
          pulseLive: checklist?.pulseLive ?? false,
          requestConnections: checklist?.config?.requestConnections ?? false,
          accountingTool: toolAcc,
          crmTool: toolCrm,
          crmDrives: nextDrives,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to confirm tools.");
      }
      await handleAutoCompleteTask("p2_confirm_tools");
      await loadChecklist();
      setFeedback({ type: "success", message: "Accounting and CRM tools confirmed." });
      if (onSetupModeToggled) {
        onSetupModeToggled({ setupMode: checklist?.setupMode ?? true, pulseLive: checklist?.pulseLive ?? false });
      }
      if (onClientsChanged) onClientsChanged();
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setConfirmingTools(false);
    }
  };

  // Step 1 Task 2: Send connection-request email to client
  const handleSendConnectionRequestEmail = async (e) => {
    e?.preventDefault();
    const cleanTo = String(inviteEmailTo || "").toLowerCase().trim();
    if (!cleanTo || !cleanTo.includes("@")) {
      setFeedback({ type: "error", message: "Please enter a valid client email address." });
      return;
    }
    if (!inviteEmailSubject.trim() || !inviteEmailBody.trim()) {
      setFeedback({ type: "error", message: "Please enter both an email subject and message body." });
      return;
    }
    setSendingInviteEmail(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/client-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "send_connection_email",
          clientName,
          masterSheetId: effectiveMasterSheetId || "",
          toEmail: cleanTo,
          subject: inviteEmailSubject.trim(),
          body: inviteEmailBody.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to send connection request email.");
      }
      advanceTaskExpansion("p2_request_connections_email", checklist?.phases);
      await loadChecklist();
      setFeedback({ type: "success", message: `Connection request email sent to ${cleanTo}.` });
      if (onSetupModeToggled) {
        onSetupModeToggled({ setupMode: checklist?.setupMode ?? true, pulseLive: checklist?.pulseLive ?? false });
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSendingInviteEmail(false);
    }
  };

  // End setup mode for client
  const handleCompleteSetup = async () => {
    if (!confirm(`End setup mode for ${clientName}? This will mark onboarding complete.`)) {
      return;
    }
    setCompletingSetup(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/setup/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          masterSheetId,
          setupMode: false,
          pulseLive: true,
          requestConnections: false,
          accountingTool: checklist?.config?.accountingTool || "None",
          crmTool: checklist?.config?.crmTool || "None",
          crmDrives: checklist?.config?.crmDrives || "NA"
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "success", message: "Setup mode ended. Onboarding is now complete." });
        if (onSetupModeToggled) onSetupModeToggled(false);
        if (onClientsChanged) onClientsChanged();
      } else {
        throw new Error(data.error || "Failed to end setup mode.");
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setCompletingSetup(false);
    }
  };

  // Render the collapsible widget box attached to a specific task
  const renderTaskAttachment = (task) => {
    if (!task) return null;

    return (
      <div style={{ marginTop: "10px", paddingTop: "10px", borderTop: "1px solid #E2E8F0" }}>
        {task.description && (
          <p style={{ margin: "0 0 10px", fontSize: "12px", color: "#475569", lineHeight: "1.5" }}>
            {task.description}
          </p>
        )}

        {/* Step 0: Authorise IMPORTRANGE connections (only when Master Google Sheet is used) */}
        {isUserAdmin && task.id === "p1_importrange_auth" && effectiveMasterMode === "sheet" && (
          <div style={{ padding: "14px 18px", borderRadius: "10px", background: "#FFFFFF", border: "1px solid #E2E8F0" }}>
            <span style={{ fontSize: "12px", fontWeight: "700", color: "#475569", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Quick links & authorisations
            </span>
            <div style={{ display: "flex", gap: "16px", marginTop: "8px", flexWrap: "wrap" }}>
              {checklist?.hasRealMasterSheet && effectiveMasterSheetId && (
                <a
                  href={`https://docs.google.com/spreadsheets/d/${effectiveMasterSheetId}/edit#gid=0`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: "13px", fontWeight: "600", color: "#0284C7", textDecoration: "none" }}
                >
                  Authorise Master IMPORTRANGE ↗
                </a>
              )}
              {effectiveClientMode === "sheet" && checklist?.hasRealClientSheet && effectiveClientSheetId && (
                <a
                  href={`https://docs.google.com/spreadsheets/d/${effectiveClientSheetId}/edit`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: "13px", fontWeight: "600", color: "#0284C7", textDecoration: "none" }}
                >
                  Authorise Client IMPORTRANGE ↗
                </a>
              )}
            </div>
          </div>
        )}

        {/* Step 0: Deploy Master sheet GAS and copy deployment URL (only when Master Google Sheet is used) */}
        {isUserAdmin && task.id === "p1_gas_deployment" && effectiveMasterMode === "sheet" && (
          <div style={{ padding: "16px", borderRadius: "10px", background: "#FFFBEB", border: "1px solid #FDE68A" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
              <span style={{ fontSize: "13px", fontWeight: "700", color: "#B45309" }}>
                Master sheet GAS deployment URL
              </span>
              {checklist?.hasRealMasterSheet && effectiveMasterSheetId && (
                <a
                  href={`https://docs.google.com/spreadsheets/d/${effectiveMasterSheetId}/edit`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: "12px", fontWeight: "600", color: "#0284C7", textDecoration: "none" }}
                >
                  Open master script editor ↗
                </a>
              )}
            </div>
            <p style={{ margin: "0 0 10px", fontSize: "12px", color: "#92400E" }}>
              Deploy the Master sheet GAS as a Web App (Deploy &gt; New deployment &gt; Web app), and paste the URL below:
            </p>
            <form onSubmit={handleSaveDeploymentUrl} style={{ display: "flex", gap: "10px" }}>
              <input
                type="text"
                placeholder="https://script.google.com/macros/s/.../exec"
                value={deploymentUrl}
                onChange={(e) => setDeploymentUrl(e.target.value)}
                style={{ flex: 1, padding: "8px 12px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px" }}
              />
              <button
                type="submit"
                disabled={savingDeploymentUrl}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#023f98",
                  color: "#FFFFFF",
                  fontWeight: "700",
                  fontSize: "13px",
                  cursor: savingDeploymentUrl ? "wait" : "pointer"
                }}
              >
                {savingDeploymentUrl ? "Saving..." : "Save URL"}
              </button>
            </form>
          </div>
        )}

        {/* Step 0: Copy GAS script IDs (only for Google Sheets-based parts) */}
        {isUserAdmin && task.id === "p1_script_ids" && (showClientScriptInput || showMasterScriptInputs) && (
          <div style={{ padding: "16px", borderRadius: "10px", background: "#FFFFFF", border: "1px solid #E2E8F0" }}>
            <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E293B", marginBottom: "6px" }}>
              Record script IDs for Google Sheets
            </span>
            <p style={{ margin: "0 0 12px", fontSize: "12px", color: "#64748B" }}>
              From Project Settings in each Google Sheet’s Apps Script editor, copy the Script ID and paste below:
            </p>
            <form onSubmit={handleSaveScriptIds}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px", marginBottom: "12px" }}>
                {showClientScriptInput && (
                  <div>
                    <label style={{ display: "block", fontSize: "11px", fontWeight: "700", color: "#475569", marginBottom: "4px" }}>
                      Client script ID
                    </label>
                    <input
                      type="text"
                      placeholder="Paste client script ID"
                      value={clientScriptId}
                      onChange={(e) => setClientScriptId(e.target.value)}
                      style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                    />
                  </div>
                )}
                {showMasterScriptInputs && (
                  <>
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "700", color: "#475569", marginBottom: "4px" }}>
                        Master script ID
                      </label>
                      <input
                        type="text"
                        placeholder="Paste master script ID"
                        value={masterScriptId}
                        onChange={(e) => setMasterScriptId(e.target.value)}
                        style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      />
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: "11px", fontWeight: "700", color: "#475569", marginBottom: "4px" }}>
                        Recon script ID
                      </label>
                      <input
                        type="text"
                        placeholder="Paste recon script ID"
                        value={reconScriptId}
                        onChange={(e) => setReconScriptId(e.target.value)}
                        style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                      />
                    </div>
                  </>
                )}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  type="submit"
                  disabled={savingScriptIds}
                  style={{
                    padding: "7px 16px",
                    borderRadius: "6px",
                    border: "none",
                    background: "#023f98",
                    color: "#FFFFFF",
                    fontWeight: "700",
                    fontSize: "12px",
                    cursor: savingScriptIds ? "wait" : "pointer"
                  }}
                >
                  {savingScriptIds ? "Saving IDs..." : "Save script IDs"}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Step 1 Task 1: Confirm accounting and CRM tools */}
        {task.id === "p2_confirm_tools" && (
          <form
            onSubmit={handleConfirmTools}
            style={{ padding: "14px 16px", borderRadius: "10px", background: "#FFFFFF", border: "1px solid #CBD5E1", display: "flex", flexDirection: "column", gap: "12px" }}
          >
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "12px" }}>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
                  Accounting tool
                </label>
                <select
                  value={toolAcc}
                  onChange={(e) => setToolAcc(e.target.value)}
                  disabled={confirmingTools}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", background: "#FFFFFF", color: "#1E293B", boxSizing: "border-box" }}
                >
                  <option value="None">None</option>
                  <option value="Xero">Xero</option>
                  <option value="Quickbooks">QuickBooks Online</option>
                </select>
              </div>

              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
                  CRM tool
                </label>
                <select
                  value={toolCrm}
                  onChange={(e) => {
                    const next = e.target.value;
                    setToolCrm(next);
                    if (next === "None") setToolCrmDrives("NA");
                  }}
                  disabled={confirmingTools}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", background: "#FFFFFF", color: "#1E293B", boxSizing: "border-box" }}
                >
                  <option value="None">None</option>
                  <option value="ClickUp">ClickUp</option>
                  <option value="Close">Close CRM</option>
                  <option value="Capsule">Capsule CRM</option>
                  <option value="HubSpot">HubSpot</option>
                  <option value="Monday">Monday.com</option>
                  <option value="Pipedrive">Pipedrive</option>
                  <option value="Google Sheet">Google Sheet</option>
                  <option value="Excel">Excel</option>
                </select>
              </div>

              {toolCrm !== "None" && (
                <div>
                  <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
                    CRM integration type
                  </label>
                  <select
                    value={toolCrmDrives}
                    onChange={(e) => setToolCrmDrives(e.target.value)}
                    disabled={confirmingTools}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "13px", background: "#FFFFFF", color: "#1E293B", boxSizing: "border-box" }}
                  >
                    <option value="NA">NA</option>
                    <option value="Pipeline">Pipeline (Just pipeline)</option>
                    <option value="PipeAndConf">PipeAndConf (Pipeline and confirmed)</option>
                  </select>
                </div>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="submit"
                disabled={confirmingTools}
                style={{
                  padding: "8px 18px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#023f98",
                  color: "#FFFFFF",
                  fontSize: "12.5px",
                  fontWeight: "700",
                  cursor: confirmingTools ? "wait" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                {confirmingTools && <Spinner size={12} color="#FFFFFF" />}
                <span>{confirmingTools ? "Confirming..." : "Confirm"}</span>
              </button>
            </div>
          </form>
        )}

        {/* Step 1 Task 2: Email client to request connections */}
        {task.id === "p2_request_connections_email" && (
          <form
            onSubmit={handleSendConnectionRequestEmail}
            style={{ padding: "14px 16px", borderRadius: "10px", background: "#FFFFFF", border: "1px solid #CBD5E1", display: "flex", flexDirection: "column", gap: "10px" }}
          >
            {inviteContacts.length > 1 && (
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
                  Select client contact
                </label>
                <select
                  value={inviteEmailTo}
                  onChange={(e) => {
                    const chosen = inviteContacts.find((c) => c.email === e.target.value);
                    setInviteEmailTo(e.target.value);
                    setInviteContactName(chosen?.name || "");
                    setInviteBodyDirty(false);
                  }}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12.5px", background: "#FFFFFF", boxSizing: "border-box" }}
                >
                  {inviteContacts.map((c) => (
                    <option key={c.email} value={c.email}>
                      {c.name ? `${c.name} (${c.email})` : c.email}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "10px" }}>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
                  To
                </label>
                <input
                  type="email"
                  required
                  placeholder="client@company.co.uk"
                  value={inviteEmailTo}
                  onChange={(e) => setInviteEmailTo(e.target.value)}
                  disabled={sendingInviteEmail}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12.5px", boxSizing: "border-box" }}
                />
              </div>
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
                  Subject
                </label>
                <input
                  type="text"
                  required
                  value={inviteEmailSubject}
                  onChange={(e) => {
                    setInviteEmailSubject(e.target.value);
                    setInviteBodyDirty(true);
                  }}
                  disabled={sendingInviteEmail}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12.5px", boxSizing: "border-box" }}
                />
              </div>
            </div>

            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: "700", color: "#334155", marginBottom: "4px" }}>
                Message
              </label>
              <textarea
                rows={10}
                required
                value={inviteEmailBody}
                onChange={(e) => {
                  setInviteEmailBody(e.target.value);
                  setInviteBodyDirty(true);
                }}
                disabled={sendingInviteEmail}
                style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12.5px", lineHeight: 1.5, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" }}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
              <span style={{ fontSize: "11px", color: "#64748B" }}>
                Sending from pulse@pulsedashboard.co.uk
              </span>
              <button
                type="submit"
                disabled={sendingInviteEmail}
                style={{
                  padding: "8px 18px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#023f98",
                  color: "#FFFFFF",
                  fontSize: "12.5px",
                  fontWeight: "700",
                  cursor: sendingInviteEmail ? "wait" : "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                {sendingInviteEmail && <Spinner size={12} color="#FFFFFF" />}
                <span>{sendingInviteEmail ? "Sending..." : "Send"}</span>
              </button>
            </div>
          </form>
        )}

        {/* Step 1: Adjust core settings in KeyInfo */}
        {task.id === "p2_keyinfo_settings" && (
          <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            <div style={{ padding: "14px 16px", borderRadius: "10px", background: "#EFF6FF", border: "1px solid #BFDBFE" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
                <div>
                  <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E40AF" }}>
                    Auto-suggest accounting initial settings
                  </span>
                  <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#3B82F6" }}>
                    Inspects connected accounting tool (Xero/QuickBooks) to auto-suggest tracker start date (formatted d-Mmm-yy), VAT quarters, scheme, and PAYE cycle.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAccountingModal(true)}
                  style={{
                    padding: "8px 16px",
                    borderRadius: "6px",
                    border: "none",
                    background: "#023f98",
                    color: "#FFFFFF",
                    fontSize: "12px",
                    fontWeight: "700",
                    cursor: "pointer"
                  }}
                >
                  Auto-suggest settings
                </button>
              </div>
            </div>

            <div style={{ padding: "16px", borderRadius: "10px", background: "#FFFFFF", border: "1px solid #E2E8F0" }}>
              <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E293B", marginBottom: "12px" }}>
                {isUserAdmin ? "Master sheet KeyInfo settings form" : "Core financial settings"}
              </span>
              <KeyInfoSettingsForm
                masterSheetId={effectiveMasterSheetId}
                clientName={clientName}
                isAdmin={isUserAdmin}
                onSaved={() => {
                  advanceTaskExpansion("p2_keyinfo_settings", checklist?.phases);
                  applyOptimisticTaskStatus("p2_keyinfo_settings", true);
                  onClientsChanged?.();
                }}
              />
            </div>
          </div>
        )}

        {/* Step 2: Pull Chart of Accounts & select manual tracking categories */}
        {task.id === "p3_chart_of_accounts" && (
          <ManualCategoryTrackingPanel
            clientName={clientName}
            masterSheetId={effectiveMasterSheetId}
            isAdmin={isUserAdmin}
            onSaved={() => {
              handleAutoCompleteTask("p3_chart_of_accounts");
              setFeedback({
                type: "success",
                message: isUserAdmin
                  ? "Manual tracking categories saved to Master Sheet KeyInfo!AT4:AT40."
                  : "Manual tracking categories saved."
              });
              onClientsChanged?.();
            }}
          />
        )}

        {/* Step 2: Pull P&L and Year 0 P&L and assign categories */}
        {task.id === "p3_pull_pl" && (
          <div style={{ padding: "14px 16px", borderRadius: "10px", background: "#EFF6FF", border: "1px solid #BFDBFE" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
              <div>
                <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E40AF" }}>
                  Pull P&amp;L &amp; auto-suggest category mappings
                </span>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#3B82F6" }}>
                  Fetches multi-year P&amp;L categories, section headers, and Chart of Accounts accounts, and auto-classifies into Revenue, CoS staff costs, Other CoS, Tax, Depreciation, and Ignore.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCategoryModal(true)}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#023f98",
                  color: "#FFFFFF",
                  fontSize: "12px",
                  fontWeight: "700",
                  cursor: "pointer"
                }}
              >
                Get started
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Check Year 0 setup, adding dividends in lieu of salary as required */}
        {task.id === "p3_year0_setup" && (
          <div style={{ padding: "14px 16px", borderRadius: "10px", background: "#EFF6FF", border: "1px solid #BFDBFE" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
              <div>
                <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E40AF" }}>
                  Review Year 0 P&amp;L &amp; dividends in lieu of salary
                </span>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#3B82F6" }}>
                  Pulls the 12 months of P&amp;L leading up to the system start date, lets you add dividends in lieu of salary with delivery %, and apply monthly category adjustments.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowYear0Modal(true)}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#023f98",
                  color: "#FFFFFF",
                  fontSize: "12px",
                  fontWeight: "700",
                  cursor: "pointer"
                }}
              >
                Get started
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Initial invoice setup */}
        {task.id === "p3_sync_invoices" && (
          <div style={{ padding: "14px 16px", borderRadius: "10px", background: "#EFF6FF", border: "1px solid #BFDBFE" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
              <div>
                <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E40AF" }}>
                  Initial invoice setup &amp; retainer detection
                </span>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#3B82F6" }}>
                  Imports 12 months of sales invoices leading up to the start date, suggests recurring retainer jobs, and creates project jobs for remaining recent invoices.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowInitialInvoicesModal(true)}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#023f98",
                  color: "#FFFFFF",
                  fontSize: "12px",
                  fontWeight: "700",
                  cursor: "pointer"
                }}
              >
                Get started
              </button>
            </div>
          </div>
        )}

        {/* Run StarterPL setup */}
        {task.id === "p3_starter_pl" && (
          <div style={{ padding: "14px 16px", borderRadius: "10px", background: "#EFF6FF", border: "1px solid #BFDBFE" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
              <div>
                <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E40AF" }}>
                  {isUserAdmin ? "StarterPL setup & cost forecasting" : "Opening P&L setup & cost forecasting"}
                </span>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#3B82F6" }}>
                  Pulls historical P&amp;L categories, allocates contractor bills across months, estimates employee salaries, sets dividends in lieu of salary, and builds your FY1 and FY2 forecast.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowStarterPlModal(true)}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#023f98",
                  color: "#FFFFFF",
                  fontSize: "12px",
                  fontWeight: "700",
                  cursor: "pointer"
                }}
              >
                Get started
              </button>
            </div>
          </div>
        )}

        {/* Create budget */}
        {task.id === "p3_other_expenses" && (
          <div style={{ padding: "14px 16px", borderRadius: "10px", background: "#EFF6FF", border: "1px solid #BFDBFE" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
              <div>
                <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E40AF" }}>
                  Create budget
                </span>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#3B82F6" }}>
                  Populates the FY1 budget from Confirmed + Pipeline + NB to find revenue, Staff salaries (actuals + forecast), Dividends, Contractors, and Other expenses with live editing.
                </p>
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => setShowCreateBudgetModal(true)}
                  style={{
                    padding: "8px 16px",
                    borderRadius: "6px",
                    border: "none",
                    background: "#023f98",
                    color: "#FFFFFF",
                    fontSize: "12px",
                    fontWeight: "700",
                    cursor: "pointer"
                  }}
                >
                  Get started
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (onGoToBudget) onGoToBudget(clientName);
                    else if (onOpenSheetEditor) onOpenSheetEditor("budget");
                    else if (typeof window !== "undefined") window.location.href = `/pma?nav=budget&client=${encodeURIComponent(clientName || "")}`;
                  }}
                  style={{
                    padding: "8px 14px",
                    borderRadius: "6px",
                    border: "1px solid #CBD5E1",
                    background: "#FFFFFF",
                    color: "#1E293B",
                    fontWeight: "600",
                    fontSize: "12px",
                    cursor: "pointer"
                  }}
                >
                  Open full budget view
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Select bank accounts */}
        {task.id === "p3_select_bank_accounts" && (
          <div style={{ padding: "14px 16px", borderRadius: "10px", background: "#EFF6FF", border: "1px solid #BFDBFE" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
              <div>
                <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E40AF" }}>
                  Select bank accounts
                </span>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#3B82F6" }}>
                  Choose which accounting bank accounts are tracked as cash vs non-cash (used for opening cash figures and cash reconciliation).
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowSelectBankAccountsModal(true)}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#023f98",
                  color: "#FFFFFF",
                  fontSize: "12px",
                  fontWeight: "700",
                  cursor: "pointer"
                }}
              >
                Get started
              </button>
            </div>
          </div>
        )}

        {/* Add cash opening figure */}
        {task.id === "p3_cash_opening" && (
          <div style={{ padding: "14px 16px", borderRadius: "10px", background: "#EFF6FF", border: "1px solid #BFDBFE" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
              <div>
                <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E40AF" }}>
                  Add cash opening figure
                </span>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#3B82F6" }}>
                  Detects month-end bank statement and ledger balances (flagging any unreconciled items) to set the opening cash figures for the previous and current months.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCashOpeningModal(true)}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#023f98",
                  color: "#FFFFFF",
                  fontSize: "12px",
                  fontWeight: "700",
                  cursor: "pointer"
                }}
              >
                Get started
              </button>
            </div>
          </div>
        )}

        {/* Update initial tax payment amounts */}
        {task.id === "p3_initial_tax_payments" && (
          <div style={{ padding: "14px 16px", borderRadius: "10px", background: "#EFF6FF", border: "1px solid #BFDBFE" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
              <div>
                <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E40AF" }}>
                  Update initial tax payment amounts
                </span>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#3B82F6" }}>
                  Estimates the initial Year 0 corporation tax and opening quarter VAT payment(s) from Balance Sheet provisions, accounting transactions, and Year 0 P&amp;L.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowInitialTaxModal(true)}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#023f98",
                  color: "#FFFFFF",
                  fontSize: "12px",
                  fontWeight: "700",
                  cursor: "pointer"
                }}
              >
                Get started
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Review CRM data & match existing Pipeline jobs */}
        {task.id === "p4_review_crm" && (
          <div style={{ padding: "14px 16px", borderRadius: "10px", background: "#EFF6FF", border: "1px solid #BFDBFE" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
              <div>
                <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E40AF" }}>
                  {isUserAdmin ? "Match CRM deals to existing Pipeline jobs" : "Match CRM deals to existing pipeline jobs"}
                </span>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#3B82F6" }}>
                  Matches incoming CRM deals against existing jobs without a Project code so duplicates are avoided on CRM sync.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCrmMatchModal(true)}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#023f98",
                  color: "#FFFFFF",
                  fontSize: "12px",
                  fontWeight: "700",
                  cursor: "pointer"
                }}
              >
                Match existing jobs
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Set up CRMList mappings & definitions */}
        {task.id === "p4_crm_list_tab" && (
          <div style={{ padding: "14px 16px", borderRadius: "10px", background: "#EFF6FF", border: "1px solid #BFDBFE" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
              <div>
                <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E40AF" }}>
                  Auto-suggest CRM mappings & rules
                </span>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#3B82F6" }}>
                  Inspects 100+ sample deals from {isUserAdmin ? "DataFromCRM" : "connected CRM data"} to match the 13 Pulse fields, determine transformation rules, and suggest confirmed job criteria.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCrmModal(true)}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#023f98",
                  color: "#FFFFFF",
                  fontSize: "12px",
                  fontWeight: "700",
                  cursor: "pointer"
                }}
              >
                Auto-suggest CRM mappings
              </button>
            </div>
          </div>
        )}

        {/* Step 1: Update other DataChgAlert / automation flags */}
        {task.id === "p4_datachg_flags" && (
          <SetupAutomationFlagsPanel
            clientName={clientName}
            masterSheetId={effectiveMasterSheetId}
            clientSheetId={checklist?.clientSheetId || clientSheetId || ""}
            isAdmin={isUserAdmin}
            onSaved={() => {
              handleAutoCompleteTask("p4_datachg_flags");
              setFeedback({
                type: "success",
                message: "Automation flags and discrepancy rules saved."
              });
            }}
          />
        )}

        {/* Step 4 Task 1: Make Pulse live (leaving client in setup mode) */}
        {task.id === "p5_make_live" && (
          <div
            style={{
              padding: "14px 16px",
              borderRadius: "10px",
              background: checklist?.pulseLive ? "#F0FDF4" : "#EFF6FF",
              border: `1px solid ${checklist?.pulseLive ? "#BBF7D0" : "#BFDBFE"}`,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
              <div style={{ flex: "1 1 280px" }}>
                <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: checklist?.pulseLive ? "#166534" : "#1E40AF" }}>
                  {checklist?.pulseLive ? "Pulse is live (setup mode remains active)" : "Activate client access while staying in setup mode"}
                </span>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: checklist?.pulseLive ? "#15803D" : "#3B82F6" }}>
                  {checklist?.pulseLive
                    ? "Client users can access live dashboards and scheduled automations are active. Finish final data capture below, then confirm ending setup mode."
                    : "Opens live dashboards for client users and starts scheduled automation syncs while keeping the client in setup mode for final data capture."}
                </p>
              </div>
              {checklist?.pulseLive ? (
                <span
                  style={{
                    fontSize: "12px",
                    fontWeight: "700",
                    color: "#15803D",
                    background: "#DCFCE7",
                    border: "1px solid #86EFAC",
                    padding: "6px 12px",
                    borderRadius: "8px",
                  }}
                >
                  Pulse is live
                </span>
              ) : (
                <button
                  type="button"
                  onClick={handleMakePulseLive}
                  disabled={makingPulseLive}
                  style={{
                    padding: "8px 16px",
                    borderRadius: "6px",
                    border: "none",
                    background: "#16A34A",
                    color: "#FFFFFF",
                    fontSize: "12px",
                    fontWeight: "700",
                    cursor: makingPulseLive ? "wait" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  {makingPulseLive && <Spinner size={12} color="#FFFFFF" />}
                  <span>Make Pulse live</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Step 4 Task 2: Email client & track final data capture items */}
        {task.id === "p5_email_client" && (() => {
          const parsedMeta = parseFinalDataCaptureMetadata(task.metadata);
          const itemStates = parsedMeta.items || {};
          const checkedCount = FINAL_DATA_CAPTURE_ITEMS.filter((it) => Boolean(itemStates[it.key])).length;

          return (
            <div style={{ padding: "14px 16px", borderRadius: "10px", background: "#FFFFFF", border: "1px solid #CBD5E1", display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
                <div>
                  <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#0F172A" }}>
                    Final data capture checklist ({checkedCount} of {FINAL_DATA_CAPTURE_ITEMS.length} received &amp; actioned)
                  </span>
                  <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#64748B" }}>
                    Send the go-live email to the client requesting the items below, then tick each item as it is received and actioned.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleCopyGoLiveEmail}
                  style={{
                    padding: "6px 12px",
                    borderRadius: "6px",
                    border: "1px solid #CBD5E1",
                    background: copiedGoLiveEmail ? "#ECFDF5" : "#F8FAFC",
                    color: copiedGoLiveEmail ? "#047857" : "#023f98",
                    fontSize: "12px",
                    fontWeight: "600",
                    cursor: "pointer",
                  }}
                >
                  {copiedGoLiveEmail ? "Copied email points" : "Copy email points"}
                </button>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {FINAL_DATA_CAPTURE_ITEMS.map((item) => {
                  const isItemDone = Boolean(itemStates[item.key]);
                  const isSavingThis = savingCaptureItemKey === item.key;
                  return (
                    <label
                      key={item.key}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "10px",
                        padding: "8px 10px",
                        borderRadius: "6px",
                        background: isItemDone ? "#F0FDF4" : "#F8FAFC",
                        border: `1px solid ${isItemDone ? "#BBF7D0" : "#E2E8F0"}`,
                        cursor: isSavingThis ? "wait" : "pointer",
                        fontSize: "12.5px",
                        color: isItemDone ? "#166534" : "#1E293B",
                        fontWeight: isItemDone ? "600" : "500",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isItemDone}
                        disabled={Boolean(savingCaptureItemKey)}
                        onChange={() => handleToggleFinalCaptureItem(task, item.key)}
                        style={{ width: "16px", height: "16px", marginTop: "2px", cursor: savingCaptureItemKey ? "wait" : "pointer", flexShrink: 0 }}
                      />
                      <span style={{ textDecoration: isItemDone ? "line-through" : "none" }}>
                        {item.label}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </div>
    );
  };

  if (loading && !checklist) {
    return (
      <div style={{ background: "#FFFFFF", borderRadius: "12px", border: "1px solid #E2E8F0", padding: "60px 20px", textAlign: "center" }}>
        <Spinner size={32} color="#023f98" />
        <p style={{ marginTop: "12px", color: "#64748B", fontSize: "14px", fontWeight: "600" }}>Loading onboarding checklist...</p>
      </div>
    );
  }

  const { phases: rawPhases = [] } = checklist || {};
  const visiblePhases = rawPhases.filter((p) => isUserAdmin || (p.id !== "phase_1" && !p.adminOnly));

  let completedCount = 0;
  let totalTasks = 0;
  visiblePhases.forEach((p) => {
    totalTasks += Number(p.totalCount) || (Array.isArray(p.tasks) ? p.tasks.length : 0);
    completedCount += Number(p.completedCount) || 0;
  });
  const progressPercent = totalTasks > 0 ? Math.round((completedCount / totalTasks) * 100) : 0;

  return (
    <div>
      {/* Feedback Banner */}
      {feedback && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: "8px",
            marginBottom: "16px",
            fontSize: "13px",
            fontWeight: "500",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            background: feedback.type === "success" ? "#ECFDF5" : "#FEF2F2",
            border: `1px solid ${feedback.type === "success" ? "#A7F3D0" : "#FECACA"}`,
            color: feedback.type === "success" ? "#065F46" : "#991B1B"
          }}
        >
          <span>{feedback.type === "success" ? "✓" : "⚠️"}</span>
          <span>{feedback.message}</span>
        </div>
      )}

      {/* Progress Card */}
      <div
        style={{
          background: "#FFFFFF",
          borderRadius: "12px",
          border: "1px solid #E2E8F0",
          padding: "20px 24px",
          marginBottom: "20px",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px", flexWrap: "wrap", gap: "10px" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
              <span
                style={{
                  fontSize: "12px",
                  fontWeight: "700",
                  padding: "2px 8px",
                  borderRadius: "10px",
                  background: checklist?.pulseLive ? "#DBEAFE" : "#FEF3C7",
                  color: checklist?.pulseLive ? "#1D4ED8" : "#B45309",
                }}
              >
                {checklist?.pulseLive ? "PULSE LIVE (IN SETUP)" : "SETUP MODE ACTIVE"}
              </span>
              {isUserAdmin && (
                <>
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: "600",
                      padding: "2px 8px",
                      borderRadius: "10px",
                      background: effectiveClientMode === "supabase" ? "#DCFCE7" : "#EFF6FF",
                      color: effectiveClientMode === "supabase" ? "#166534" : "#1E40AF"
                    }}
                  >
                    Client: {effectiveClientMode === "supabase" ? "Supabase" : "Google Sheets"}
                  </span>
                  <span
                    style={{
                      fontSize: "11px",
                      fontWeight: "600",
                      padding: "2px 8px",
                      borderRadius: "10px",
                      background: effectiveMasterMode === "supabase" ? "#DCFCE7" : "#EFF6FF",
                      color: effectiveMasterMode === "supabase" ? "#166534" : "#1E40AF"
                    }}
                  >
                    Master: {effectiveMasterMode === "supabase" ? "Supabase" : "Google Sheets"}
                  </span>
                </>
              )}
              <h2 style={{ margin: 0, fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>
                Onboarding progress: {clientName}
              </h2>
            </div>
            <p style={{ margin: "4px 0 0", fontSize: "13px", color: "#64748B" }}>
              Follow the checklist below to configure the client system, connect third-party APIs, and verify financial baselines.
            </p>
          </div>
          <div style={{ textAlign: "right" }}>
            <span style={{ fontSize: "24px", fontWeight: "800", color: "#023f98" }}>{progressPercent}%</span>
            <span style={{ fontSize: "13px", color: "#64748B", marginLeft: "6px" }}>
              ({completedCount} of {totalTasks} tasks)
            </span>
          </div>
        </div>

        {/* Progress Bar */}
        <div style={{ width: "100%", height: "8px", borderRadius: "4px", background: "#E2E8F0", overflow: "hidden" }}>
          <div
            style={{
              width: `${progressPercent}%`,
              height: "100%",
              background: progressPercent === 100 ? "#10B981" : "#023f98",
              borderRadius: "4px",
              transition: "width 0.3s ease"
            }}
          />
        </div>
      </div>

      {/* Phases Accordion */}
      <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginBottom: "24px" }}>
        {(() => {
          let seqStep = 0;
          return visiblePhases.map((phase) => {
            const displayStepNum = phase.id === "phase_1" || phase.adminOnly ? null : ++seqStep;
            const isOpen = openPhaseId === phase.id;
            return (
              <div
                key={phase.id}
                style={{
                  background: "#FFFFFF",
                  borderRadius: "12px",
                  border: "1px solid #E2E8F0",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                  overflow: "hidden"
                }}
              >
                {/* Phase Header */}
                <button
                  type="button"
                  onClick={() => setOpenPhaseId(isOpen ? "" : phase.id)}
                  style={{
                    width: "100%",
                    padding: "16px 20px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    background: isOpen ? "#F8FAFC" : "#FFFFFF",
                    border: "none",
                    borderBottom: isOpen ? "1px solid #E2E8F0" : "none",
                    cursor: "pointer",
                    textAlign: "left"
                  }}
                >
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <h3 style={{ margin: "0 0 2px", fontSize: "15px", fontWeight: "700", color: "#0F172A" }}>
                        {formatPhaseTitle(phase.title, displayStepNum)}
                      </h3>
                      {phase.id === "phase_1" && isUserAdmin && (
                        <span
                          style={{
                            fontSize: "10px",
                            fontWeight: "700",
                            padding: "2px 6px",
                            borderRadius: "6px",
                            background: "#EFF6FF",
                            color: "#1E40AF",
                            border: "1px solid #BFDBFE"
                          }}
                        >
                          Admin only
                        </span>
                      )}
                    </div>
                    <p style={{ margin: 0, fontSize: "12px", color: "#64748B" }}>{formatPhaseDescription(phase.description)}</p>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <span
                      style={{
                        fontSize: "12px",
                        fontWeight: "700",
                        padding: "3px 10px",
                        borderRadius: "12px",
                        background: phase.isPhaseComplete ? "#DCFCE7" : "#F1F5F9",
                        color: phase.isPhaseComplete ? "#15803D" : "#475569"
                      }}
                    >
                      {phase.isPhaseComplete ? "✓ Complete" : `${phase.completedCount} / ${phase.totalCount}`}
                    </span>
                    <span style={{ fontSize: "14px", color: "#94A3B8" }}>{isOpen ? "▲" : "▼"}</span>
                  </div>
                </button>

                {/* Phase Body */}
                {isOpen && (
                  <div style={{ padding: "20px" }}>
                    {/* Tasks List */}
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      {phase.tasks.map((task) => {
                        const attachable = hasTaskAttachment(task);
                        const isTaskExpanded = Boolean(expandedTaskIds[task.id]);

                        return (
                          <div
                            key={task.id}
                            style={{
                              padding: "10px 14px",
                              borderRadius: "8px",
                              background: task.isCompleted ? "#F0FDF4" : "#F8FAFC",
                              border: `1px solid ${task.isCompleted ? "#BBF7D0" : isTaskExpanded ? "#93C5FD" : "#E2E8F0"}`,
                              transition: "border-color 0.15s ease"
                            }}
                          >
                            <div
                              onClick={() => {
                                if (attachable) toggleTaskExpanded(task.id);
                              }}
                              style={{
                                display: "flex",
                                alignItems: "flex-start",
                                gap: "10px",
                                cursor: attachable ? "pointer" : "default"
                              }}
                            >
                              {attachable ? (
                                <button
                                  type="button"
                                  aria-label={isTaskExpanded ? "Collapse task details" : "Expand task details"}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleTaskExpanded(task.id);
                                  }}
                                  style={{
                                    background: "transparent",
                                    border: "none",
                                    padding: "2px 4px",
                                    marginTop: "1px",
                                    fontSize: "11px",
                                    color: isTaskExpanded ? "#023f98" : "#64748B",
                                    cursor: "pointer",
                                    lineHeight: 1
                                  }}
                                >
                                  {isTaskExpanded ? "▼" : "▶"}
                                </button>
                              ) : (
                                <span style={{ width: "19px", display: "inline-block" }} />
                              )}

                              <input
                                type="checkbox"
                                checked={task.isCompleted}
                                onClick={(e) => e.stopPropagation()}
                                onChange={() => handleToggleTask(task)}
                                style={{ width: "18px", height: "18px", marginTop: "2px", cursor: "pointer" }}
                              />

                              <div style={{ flex: 1 }}>
                                <span
                                  style={{
                                    fontSize: "13px",
                                    fontWeight: "600",
                                    color: task.isCompleted ? "#166534" : "#1E293B",
                                    textDecoration: task.isCompleted ? "line-through" : "none"
                                  }}
                                >
                                  {formatTaskTitle(task)}
                                </span>
                                {task.metadata && (isUserAdmin || String(task.metadata).trim().startsWith("{")) && (
                                  <span style={{ display: "block", fontSize: "11px", color: "#64748B", marginTop: "2px" }}>
                                    {formatTaskMetadataSummary(task.metadata)}
                                  </span>
                                )}
                              </div>

                              {task.waitingOnClient && (
                                <span
                                  style={{
                                    fontSize: "10px",
                                    fontWeight: "700",
                                    color: "#B45309",
                                    background: "#FEF3C7",
                                    border: "1px solid #FDE68A",
                                    padding: "2px 7px",
                                    borderRadius: "6px",
                                    whiteSpace: "nowrap"
                                  }}
                                >
                                  Waiting on client
                                </span>
                              )}

                              {task.autoCompletable && (
                                <span style={{ fontSize: "10px", fontWeight: "700", color: "#64748B", background: "#E2E8F0", padding: "2px 6px", borderRadius: "6px" }}>
                                  Auto
                                </span>
                              )}
                            </div>

                            {/* Attached collapsible action box */}
                            {attachable && isTaskExpanded && renderTaskAttachment(task)}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          });
        })()}
      </div>

      {/* Go Live Footer Action */}
      <div
        style={{
          background: "#FFFFFF",
          borderRadius: "12px",
          border: "1px solid #E2E8F0",
          padding: "20px 24px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "14px"
        }}
      >
        <div>
          <h3 style={{ margin: "0 0 4px", fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
            End setup mode for client
          </h3>
          <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
            Confirming will take the client out of setup mode and mark onboarding complete.
          </p>
        </div>
        <button
          type="button"
          onClick={handleCompleteSetup}
          disabled={completingSetup}
          style={{
            padding: "10px 22px",
            borderRadius: "8px",
            border: "none",
            background: "#16A34A",
            color: "#FFFFFF",
            fontWeight: "700",
            fontSize: "14px",
            cursor: completingSetup ? "wait" : "pointer",
            display: "inline-flex",
            alignItems: "center",
            gap: "8px"
          }}
        >
          {completingSetup && <Spinner size={16} color="#FFFFFF" />}
          <span>Confirm</span>
        </button>
      </div>

      {/* Suggestion Modals */}
      <AccountingSettingsSuggestionModal
        clientName={clientName}
        masterSheetId={effectiveMasterSheetId}
        isAdmin={isUserAdmin}
        isOpen={showAccountingModal}
        onClose={() => setShowAccountingModal(false)}
        onApplied={() => {
          handleAutoCompleteTask("p2_keyinfo_settings");
          setFeedback({ type: "success", message: isUserAdmin ? "Initial accounting settings applied to Master Sheet." : "Initial accounting settings applied." });
        }}
      />

      <CategoryMappingSuggestionModal
        clientName={clientName}
        masterSheetId={effectiveMasterSheetId}
        isAdmin={isUserAdmin}
        isOpen={showCategoryModal}
        onClose={() => setShowCategoryModal(false)}
        onApplied={() => {
          handleAutoCompleteTask("p3_pull_pl");
          setFeedback({ type: "success", message: isUserAdmin ? "Category mapping rules applied to Master Sheet KeyInfo!BA2:BA180." : "Category mapping rules applied." });
        }}
      />

      <CrmMappingSuggestionModal
        clientName={clientName}
        masterSheetId={effectiveMasterSheetId}
        isAdmin={isUserAdmin}
        isOpen={showCrmModal}
        onClose={() => setShowCrmModal(false)}
        onApplied={() => {
          handleAutoCompleteTask("p4_crm_list_tab");
          setFeedback({ type: "success", message: isUserAdmin ? "CRM field mappings and job definitions applied to Master Sheet CRMList." : "CRM field mappings and job definitions applied." });
        }}
      />

      <MatchCrmPipelineModal
        clientName={clientName}
        masterSheetId={effectiveMasterSheetId}
        isAdmin={isUserAdmin}
        isOpen={showCrmMatchModal}
        onClose={() => setShowCrmMatchModal(false)}
        onApplied={(res) => {
          handleAutoCompleteTask("p4_review_crm");
          setFeedback({
            type: "success",
            message: `Linked ${res?.appliedCount ?? 0} existing pipeline job(s) to CRM Project codes.`,
          });
        }}
      />

      <Year0SetupModal
        clientName={clientName}
        masterSheetId={effectiveMasterSheetId}
        isOpen={showYear0Modal}
        onClose={() => setShowYear0Modal(false)}
        onCompleted={() => {
          handleAutoCompleteTask("p3_year0_setup");
          setFeedback({ type: "success", message: "Year 0 setup saved." });
        }}
      />

      <InitialInvoiceSetupModal
        clientName={clientName}
        masterSheetId={effectiveMasterSheetId}
        isOpen={showInitialInvoicesModal}
        onClose={() => setShowInitialInvoicesModal(false)}
        onCompleted={() => {
          handleAutoCompleteTask("p3_sync_invoices");
          setFeedback({ type: "success", message: "Initial invoice setup completed." });
          onClientsChanged?.();
        }}
      />

      <StarterPlModal
        clientName={clientName}
        masterSheetId={effectiveMasterSheetId}
        isAdmin={isUserAdmin}
        isOpen={showStarterPlModal}
        onClose={() => setShowStarterPlModal(false)}
        onCompleted={() => {
          handleAutoCompleteTask("p3_starter_pl");
          setFeedback({ type: "success", message: isUserAdmin ? "StarterPL setup completed." : "Opening P&L setup completed." });
          onClientsChanged?.();
        }}
      />

      <CreateBudgetModal
        clientName={clientName}
        masterSheetId={effectiveMasterSheetId}
        isAdmin={isUserAdmin}
        isOpen={showCreateBudgetModal}
        onClose={() => setShowCreateBudgetModal(false)}
        onCompleted={() => {
          handleAutoCompleteTask("p3_other_expenses");
          setFeedback({ type: "success", message: "FY1 budget saved." });
          onClientsChanged?.();
        }}
      />

      <SelectBankAccountsModal
        clientName={clientName}
        masterSheetId={effectiveMasterSheetId}
        isAdmin={isUserAdmin}
        isOpen={showSelectBankAccountsModal}
        onClose={() => setShowSelectBankAccountsModal(false)}
        onCompleted={() => {
          handleAutoCompleteTask("p3_select_bank_accounts");
          setFeedback({ type: "success", message: "Bank accounts configuration saved." });
          onClientsChanged?.();
        }}
      />

      <CashOpeningModal
        clientName={clientName}
        masterSheetId={effectiveMasterSheetId}
        isAdmin={isUserAdmin}
        isOpen={showCashOpeningModal}
        onClose={() => setShowCashOpeningModal(false)}
        onCompleted={() => {
          handleAutoCompleteTask("p3_cash_opening");
          setFeedback({ type: "success", message: "Cash opening figures saved." });
          onClientsChanged?.();
        }}
      />

      <InitialTaxPaymentsModal
        clientName={clientName}
        masterSheetId={effectiveMasterSheetId}
        isAdmin={isUserAdmin}
        isOpen={showInitialTaxModal}
        onClose={() => setShowInitialTaxModal(false)}
        onCompleted={() => {
          handleAutoCompleteTask("p3_initial_tax_payments");
          setFeedback({ type: "success", message: "Initial tax payment estimates saved." });
          onClientsChanged?.();
        }}
      />
    </div>
  );
}
