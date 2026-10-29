import React, { useState, useEffect, useCallback } from "react";
import Spinner from "./Spinner";
import KeyInfoSettingsForm from "./KeyInfoSettingsForm";
import AccountingSettingsSuggestionModal from "./setup/AccountingSettingsSuggestionModal";
import CategoryMappingSuggestionModal from "./setup/CategoryMappingSuggestionModal";
import CrmMappingSuggestionModal from "./setup/CrmMappingSuggestionModal";

export default function OnboardingChecklistView({
  clientName,
  masterSheetId,
  clientSheetId,
  user,
  onOpenSheetEditor,
  onGoToBudget,
  onGoToTasks,
  onSetupModeToggled
}) {
  const isUserAdmin = Boolean(
    !user?.isReadOnly && (user?.isAdmin || user?.role === "Admin") && user?.role !== "ClientManager"
  );

  const [loading, setLoading] = useState(true);
  const [checklist, setChecklist] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [openPhaseId, setOpenPhaseId] = useState(() => (isUserAdmin ? "phase_1" : "phase_2"));
  const [expandedTaskIds, setExpandedTaskIds] = useState({});

  useEffect(() => {
    if (!isUserAdmin && openPhaseId === "phase_1") {
      setOpenPhaseId("phase_2");
    }
  }, [isUserAdmin, openPhaseId]);

  // Automated Suggestions Modals state
  const [showAccountingModal, setShowAccountingModal] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [showCrmModal, setShowCrmModal] = useState(false);

  // Script IDs form state
  const [clientScriptId, setClientScriptId] = useState("");
  const [masterScriptId, setMasterScriptId] = useState("");
  const [reconScriptId, setReconScriptId] = useState("");
  const [savingScriptIds, setSavingScriptIds] = useState(false);

  // Deployment URL form state
  const [deploymentUrl, setDeploymentUrl] = useState("");
  const [savingDeploymentUrl, setSavingDeploymentUrl] = useState(false);

  // Completing setup
  const [completingSetup, setCompletingSetup] = useState(false);
  const [applyingEomTasks, setApplyingEomTasks] = useState(false);

  const formatPhaseTitle = (title) => {
    if (!title) return title;
    const raw = String(title);
    if (isUserAdmin) return raw;
    return raw.replace(/Infrastructure & Sheet Linking/gi, "System provisioning & initialisation");
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
    const nonAdminMap = {
      p1_drive_folder: "Create client workspace folder",
      p1_duplicate_templates: "Provision client financial models",
      p1_bookmarks: "Configure workspace shortcuts",
      p1_importrange_auth: "Authorise internal data sync connections",
      p1_agent_secret: "Configure automation security credentials",
      p1_gas_deployment: "Deploy background sync service",
      p1_rename_gas: "Configure background sync service identifiers",
      p1_script_ids: "Register client in system version tracker",
      p2_select_tools: "Select accounting tool and CRM in setup",
      p2_keyinfo_settings: "Adjust core financial settings (Start date, VAT, PAYE, Revenue focus, Profit share %)",
      p3_chart_of_accounts: "Pull Chart of Accounts and select manual categories",
      p3_pull_pl: "Pull P&L and Year 0 P&L and assign categories",
      p3_other_expenses: "Add 'other expenses' forecast amounts into Outgoings",
      p3_contractors_info: "Add contractor information to Outgoings",
      p3_dividends_info: "Add dividends in lieu of salary information to Outgoings",
      p4_crm_list_tab: "Set up CRM field mappings and Confirmed & Pipeline definitions",
      p4_agent_trigger: "Enable automated proactive checks",
      p4_pl_trigger: "Enable scheduled P&L sync",
      p4_ac_enrollment: "Enrol client in automated sync scheduler",
      p4_automation_freq: "Select frequency of automations",
      p4_datachg_flags: "Configure automated alert flags as required",
      p4_rep_control: "Enrol client in month-end reporting",
      p5_add_users: "Add client users in Settings > Users"
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

  // Determine whether a task has an expandable action box / details panel
  const hasTaskAttachment = useCallback(
    (task) => {
      if (!task) return false;
      if (isUserAdmin && ["p1_importrange_auth", "p1_gas_deployment", "p1_script_ids"].includes(task.id)) {
        return true;
      }
      if (["p2_keyinfo_settings", "p3_pull_pl", "p3_other_expenses", "p4_crm_list_tab", "p4_eom_jobs"].includes(task.id)) {
        return true;
      }
      if (task.description && String(task.description).trim()) {
        return true;
      }
      return false;
    },
    [isUserAdmin]
  );

  // Toggle expansion of a single task's attached box
  const toggleTaskExpanded = (taskId) => {
    setExpandedTaskIds((prev) => ({
      ...prev,
      [taskId]: !prev[taskId]
    }));
  };

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

  const handleApplyDefaultEomTasks = async () => {
    setApplyingEomTasks(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "eom_apply_default_tasks",
          clientName
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({
          type: "success",
          message: `Default EoM tasks applied successfully (${data.appliedCount} task${data.appliedCount !== 1 ? "s" : ""} added).`
        });
        loadChecklist();
      } else {
        throw new Error(data.error || "Failed to apply default EoM tasks.");
      }
    } catch (err) {
      setFeedback({ type: "error", message: err.message });
    } finally {
      setApplyingEomTasks(false);
    }
  };

  // Load checklist data
  const loadChecklist = useCallback(async () => {
    if (!clientName) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/setup/checklist?clientName=${encodeURIComponent(clientName)}&masterSheetId=${encodeURIComponent(masterSheetId || "")}`);
      const data = await res.json();
      if (data.success) {
        setChecklist(data);
        if (data.keyInfoSettings?.masterDeploymentUrl) {
          setDeploymentUrl(data.keyInfoSettings.masterDeploymentUrl);
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
  }, [clientName, masterSheetId]);

  useEffect(() => {
    loadChecklist();
  }, [loadChecklist]);

  // Handle task checkbox toggle
  const handleToggleTask = async (task) => {
    const newStatus = !task.isCompleted;
    setFeedback(null);

    if (newStatus) {
      advanceTaskExpansion(task.id, checklist?.phases);
    }

    // Optimistically update UI
    setChecklist((prev) => {
      if (!prev) return prev;
      const newCompletedCount = prev.completedCount + (newStatus ? 1 : -1);
      const newPhases = prev.phases.map((p) => {
        if (p.id !== task.phaseId) return p;
        const phaseComp = p.completedCount + (newStatus ? 1 : -1);
        const tasks = p.tasks.map((t) => (t.id === task.id ? { ...t, isCompleted: newStatus } : t));
        return { ...p, completedCount: phaseComp, isPhaseComplete: phaseComp === tasks.length, tasks };
      });
      return {
        ...prev,
        completedCount: newCompletedCount,
        progressPercent: prev.totalTasks > 0 ? Math.round((newCompletedCount / prev.totalTasks) * 100) : 0,
        phases: newPhases
      };
    });

    try {
      const res = await fetch("/api/setup/checklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          taskId: task.id,
          isCompleted: newStatus
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
    try {
      await fetch("/api/setup/checklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          taskId,
          isCompleted: true
        })
      });
      loadChecklist();
    } catch (err) {
      console.warn("Could not auto-complete task:", err.message);
    }
  };

  // Save Script IDs
  const handleSaveScriptIds = async (e) => {
    e?.preventDefault();
    if (!clientScriptId && !masterScriptId && !reconScriptId) {
      setFeedback({ type: "error", message: "Please enter at least one Script ID." });
      return;
    }
    setSavingScriptIds(true);
    setFeedback(null);

    try {
      const res = await fetch("/api/setup/script-ids", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          clientScriptId,
          masterScriptId,
          reconScriptId
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "success", message: `Script IDs recorded into Client Version Tracker (Row ${data.rowNum}).` });
        advanceTaskExpansion("p1_script_ids", checklist?.phases);
        loadChecklist();
      } else {
        throw new Error(data.error || "Failed to save Script IDs.");
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

  // Complete Onboarding & Go Live
  const handleCompleteSetup = async () => {
    if (!confirm(`Are you ready to complete setup for ${clientName} and activate live dashboards for client users?`)) {
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
          requestConnections: false,
          accountingTool: checklist?.config?.accountingTool || "None",
          crmTool: checklist?.config?.crmTool || "None",
          crmDrives: checklist?.config?.crmDrives || "NA"
        })
      });
      const data = await res.json();
      if (data.success) {
        setFeedback({ type: "success", message: "Setup mode deactivated. Live financial dashboards are now active." });
        if (onSetupModeToggled) onSetupModeToggled(false);
      } else {
        throw new Error(data.error || "Failed to deactivate setup mode.");
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

        {/* Step 0: Authorise IMPORTRANGE connections */}
        {isUserAdmin && task.id === "p1_importrange_auth" && (
          <div style={{ padding: "14px 18px", borderRadius: "10px", background: "#FFFFFF", border: "1px solid #E2E8F0" }}>
            <span style={{ fontSize: "12px", fontWeight: "700", color: "#475569", textTransform: "uppercase", letterSpacing: "0.5px" }}>
              Quick links & authorisations
            </span>
            <div style={{ display: "flex", gap: "16px", marginTop: "8px", flexWrap: "wrap" }}>
              {masterSheetId && (
                <a
                  href={`https://docs.google.com/spreadsheets/d/${masterSheetId}/edit#gid=0`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: "13px", fontWeight: "600", color: "#0284C7", textDecoration: "none" }}
                >
                  Authorise Master IMPORTRANGE ↗
                </a>
              )}
              {clientSheetId && (
                <a
                  href={`https://docs.google.com/spreadsheets/d/${clientSheetId}/edit`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontSize: "13px", fontWeight: "600", color: "#0284C7", textDecoration: "none" }}
                >
                  Authorise Client IMPORTRANGE ↗
                </a>
              )}
            </div>
          </div>
        )}

        {/* Step 0: Deploy Master sheet GAS and copy deployment URL */}
        {isUserAdmin && task.id === "p1_gas_deployment" && (
          <div style={{ padding: "16px", borderRadius: "10px", background: "#FFFBEB", border: "1px solid #FDE68A" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
              <span style={{ fontSize: "13px", fontWeight: "700", color: "#B45309" }}>
                Master sheet GAS deployment URL
              </span>
              {masterSheetId && (
                <a
                  href={`https://docs.google.com/spreadsheets/d/${masterSheetId}/edit`}
                  target="_blank"
                  rel="noreferrer"
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

        {/* Step 0: Copy GAS script IDs into Client Version Tracker */}
        {isUserAdmin && task.id === "p1_script_ids" && (
          <div style={{ padding: "16px", borderRadius: "10px", background: "#FFFFFF", border: "1px solid #E2E8F0" }}>
            <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E293B", marginBottom: "6px" }}>
              Record script IDs into version tracker
            </span>
            <p style={{ margin: "0 0 12px", fontSize: "12px", color: "#64748B" }}>
              From Project Settings in each sheet’s Apps Script editor, copy the Script ID and paste below:
            </p>
            <form onSubmit={handleSaveScriptIds}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px", marginBottom: "12px" }}>
                <div>
                  <label style={{ display: "block", fontSize: "11px", fontWeight: "700", color: "#475569", marginBottom: "4px" }}>
                    Client Script ID (Col R)
                  </label>
                  <input
                    type="text"
                    placeholder="Paste Client Script ID"
                    value={clientScriptId}
                    onChange={(e) => setClientScriptId(e.target.value)}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "11px", fontWeight: "700", color: "#475569", marginBottom: "4px" }}>
                    Master Script ID (Col S)
                  </label>
                  <input
                    type="text"
                    placeholder="Paste Master Script ID"
                    value={masterScriptId}
                    onChange={(e) => setMasterScriptId(e.target.value)}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "11px", fontWeight: "700", color: "#475569", marginBottom: "4px" }}>
                    Recon Script ID (Col T)
                  </label>
                  <input
                    type="text"
                    placeholder="Paste Recon Script ID"
                    value={reconScriptId}
                    onChange={(e) => setReconScriptId(e.target.value)}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: "6px", border: "1px solid #CBD5E1", fontSize: "12px", boxSizing: "border-box" }}
                  />
                </div>
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
                  {savingScriptIds ? "Saving IDs..." : "Save script IDs to tracker"}
                </button>
              </div>
            </form>
          </div>
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
                masterSheetId={masterSheetId}
                clientName={clientName}
                isAdmin={isUserAdmin}
                onSaved={() => {
                  advanceTaskExpansion("p2_keyinfo_settings", checklist?.phases);
                  loadChecklist();
                }}
              />
            </div>
          </div>
        )}

        {/* Step 2: Pull P&L and Year 0 P&L and assign categories */}
        {task.id === "p3_pull_pl" && (
          <div style={{ padding: "14px 16px", borderRadius: "10px", background: "#EFF6FF", border: "1px solid #BFDBFE" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px" }}>
              <div>
                <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E40AF" }}>
                  Auto-suggest category mappings
                </span>
                <p style={{ margin: "2px 0 0", fontSize: "12px", color: "#3B82F6" }}>
                  Downloads P&L categories from accounting tool and auto-classifies into Revenue, CoS staff costs (Salaries, Wages, NI, Pension), Other CoS, Tax, Depreciation, and Ignore headers.
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
                Auto-suggest categories
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Add 'other expenses' forecast amounts into Outgoings */}
        {task.id === "p3_other_expenses" && (
          <div style={{ padding: "16px", borderRadius: "10px", background: "#FFFFFF", border: "1px solid #E2E8F0" }}>
            <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E293B", marginBottom: "6px" }}>
              Budget table editor
            </span>
            <p style={{ margin: "0 0 12px", fontSize: "12px", color: "#64748B" }}>
              Open the budget screen to populate client financial budget forecasts across financial years:
            </p>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
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
                Edit budget table
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

        {/* Step 3: Add client details and monthly jobs to EoM section */}
        {task.id === "p4_eom_jobs" && (
          <div style={{ padding: "16px", borderRadius: "10px", background: "#FFFFFF", border: "1px solid #E2E8F0" }}>
            <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E293B", marginBottom: "6px" }}>
              End-of-month (EoM) client tasks
            </span>
            <p style={{ margin: "0 0 12px", fontSize: "12px", color: "#64748B" }}>
              Default EoM tasks are automatically assigned to this client upon creation. You can apply or re-sync default tasks, or manage tasks directly in the EoM section:
            </p>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
              <button
                type="button"
                onClick={() => handleApplyDefaultEomTasks()}
                disabled={applyingEomTasks}
                style={{
                  padding: "8px 14px",
                  borderRadius: "6px",
                  border: "1px solid #CBD5E1",
                  background: "#FFFFFF",
                  color: "#1E293B",
                  fontWeight: "600",
                  fontSize: "12px",
                  cursor: applyingEomTasks ? "wait" : "pointer"
                }}
              >
                {applyingEomTasks ? "Applying defaults..." : "Seed / re-apply default EoM tasks"}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (onGoToTasks) onGoToTasks();
                  else if (typeof window !== "undefined") window.location.href = `/pma?nav=tasks`;
                }}
                style={{
                  padding: "8px 14px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#023f98",
                  color: "#FFFFFF",
                  fontWeight: "600",
                  fontSize: "12px",
                  cursor: "pointer",
                  display: "inline-block"
                }}
              >
                Manage in EoM section →
              </button>
            </div>
          </div>
        )}
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
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <span style={{ fontSize: "12px", fontWeight: "700", padding: "2px 8px", borderRadius: "10px", background: "#FEF3C7", color: "#B45309" }}>
                SETUP MODE ACTIVE
              </span>
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
        {visiblePhases.map((phase) => {
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
                      {formatPhaseTitle(phase.title)}
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
                              {task.metadata && isUserAdmin && (
                                <span style={{ display: "block", fontSize: "11px", color: "#64748B", marginTop: "2px" }}>
                                  {task.metadata}
                                </span>
                              )}
                            </div>

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
        })}
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
            Ready to launch live dashboards?
          </h3>
          <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
            Completing setup will turn off setup mode and allow client users to access their live financial dashboards.
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
          <span>Complete onboarding & go live →</span>
        </button>
      </div>

      {/* Suggestion Modals */}
      <AccountingSettingsSuggestionModal
        clientName={clientName}
        masterSheetId={masterSheetId}
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
        masterSheetId={masterSheetId}
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
        masterSheetId={masterSheetId}
        isAdmin={isUserAdmin}
        isOpen={showCrmModal}
        onClose={() => setShowCrmModal(false)}
        onApplied={() => {
          handleAutoCompleteTask("p4_review_crm");
          handleAutoCompleteTask("p4_crm_list_tab");
          setFeedback({ type: "success", message: isUserAdmin ? "CRM field mappings and job definitions applied to Master Sheet CRMList." : "CRM field mappings and job definitions applied." });
        }}
      />
    </div>
  );
}
