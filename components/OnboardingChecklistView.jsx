import React, { useState, useEffect, useCallback } from "react";
import Spinner from "./Spinner";
import KeyInfoSettingsForm from "./KeyInfoSettingsForm";

export default function OnboardingChecklistView({
  clientName,
  masterSheetId,
  clientSheetId,
  user,
  onOpenSheetEditor,
  onGoToBudget,
  onSetupModeToggled
}) {
  const [loading, setLoading] = useState(true);
  const [checklist, setChecklist] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [openPhaseId, setOpenPhaseId] = useState("phase_1");

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

    // Optimistically update UI
    setChecklist(prev => {
      if (!prev) return prev;
      let newCompletedCount = prev.completedCount + (newStatus ? 1 : -1);
      const newPhases = prev.phases.map(p => {
        if (p.id !== task.phaseId) return p;
        let phaseComp = p.completedCount + (newStatus ? 1 : -1);
        const tasks = p.tasks.map(t => t.id === task.id ? { ...t, isCompleted: newStatus } : t);
        return { ...p, completedCount: phaseComp, isPhaseComplete: phaseComp === tasks.length, tasks };
      });
      return {
        ...prev,
        completedCount: newCompletedCount,
        progressPercent: Math.round((newCompletedCount / prev.totalTasks) * 100),
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
        setFeedback({ type: "success", message: "Master GAS Deployment URL saved to KeyInfo!X29 and tracker sheet." });
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
        setFeedback({ type: "success", message: "🎉 Setup Mode deactivated! Live financial dashboards are now active." });
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

  if (loading && !checklist) {
    return (
      <div style={{ background: "#FFFFFF", borderRadius: "12px", border: "1px solid #E2E8F0", padding: "60px 20px", textAlign: "center" }}>
        <Spinner size={32} color="#023f98" />
        <p style={{ marginTop: "12px", color: "#64748B", fontSize: "14px", fontWeight: "600" }}>Loading onboarding checklist...</p>
      </div>
    );
  }

  const { progressPercent = 0, completedCount = 0, totalTasks = 34, phases = [], config } = checklist || {};

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
                Onboarding Progress: {clientName}
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
        {phases.map((phase) => {
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
                  <h3 style={{ margin: "0 0 2px", fontSize: "15px", fontWeight: "700", color: "#0F172A" }}>
                    {phase.title}
                  </h3>
                  <p style={{ margin: 0, fontSize: "12px", color: "#64748B" }}>{phase.description}</p>
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
                  {/* Phase 1 Custom Widgets: Quick Links, Script IDs, GAS Deployment */}
                  {phase.id === "phase_1" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginBottom: "20px" }}>
                      {/* Deep Links Box */}
                      <div style={{ padding: "14px 18px", borderRadius: "10px", background: "#F8FAFC", border: "1px solid #E2E8F0" }}>
                        <span style={{ fontSize: "12px", fontWeight: "700", color: "#475569", textTransform: "uppercase", letterSpacing: "0.5px" }}>
                          Quick Links & Authorisations
                        </span>
                        <div style={{ display: "flex", gap: "16px", marginTop: "8px", flexWrap: "wrap" }}>
                          {masterSheetId && (
                            <a
                              href={`https://docs.google.com/spreadsheets/d/${masterSheetId}/edit#gid=0`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ fontSize: "13px", fontWeight: "600", color: "#0284C7", textDecoration: "none" }}
                            >
                              ⚙️ Authorise Master IMPORTRANGE ↗
                            </a>
                          )}
                          {clientSheetId && (
                            <a
                              href={`https://docs.google.com/spreadsheets/d/${clientSheetId}/edit`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ fontSize: "13px", fontWeight: "600", color: "#0284C7", textDecoration: "none" }}
                            >
                              📊 Authorise Client IMPORTRANGE ↗
                            </a>
                          )}
                        </div>
                      </div>

                      {/* Master GAS Deployment Input */}
                      <div style={{ padding: "16px", borderRadius: "10px", background: "#FFFBEB", border: "1px solid #FDE68A" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                          <span style={{ fontSize: "13px", fontWeight: "700", color: "#B45309" }}>
                            Master Sheet GAS Deployment URL (Task 6)
                          </span>
                          {masterSheetId && (
                            <a
                              href={`https://docs.google.com/spreadsheets/d/${masterSheetId}/edit`}
                              target="_blank"
                              rel="noreferrer"
                              style={{ fontSize: "12px", fontWeight: "600", color: "#0284C7", textDecoration: "none" }}
                            >
                              Open Master Script Editor ↗
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

                      {/* Script IDs Input */}
                      <div style={{ padding: "16px", borderRadius: "10px", background: "#F8FAFC", border: "1px solid #E2E8F0" }}>
                        <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E293B", marginBottom: "6px" }}>
                          Record Script IDs into Version Tracker (Task 8)
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
                              {savingScriptIds ? "Saving IDs..." : "Save Script IDs to Tracker"}
                            </button>
                          </div>
                        </form>
                      </div>
                    </div>
                  )}

                  {/* Phase 2 Custom Widgets: Integrated KeyInfo Form & Tool Connections */}
                  {phase.id === "phase_2" && (
                    <div style={{ marginBottom: "20px" }}>
                      <div style={{ padding: "16px", borderRadius: "10px", background: "#F8FAFC", border: "1px solid #E2E8F0", marginBottom: "16px" }}>
                        <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E293B", marginBottom: "12px" }}>
                          Master Sheet KeyInfo Settings Form (Task 12)
                        </span>
                        <KeyInfoSettingsForm
                          masterSheetId={masterSheetId}
                          clientName={clientName}
                          onSaved={() => loadChecklist()}
                        />
                      </div>
                    </div>
                  )}

                  {/* Phase 3 Custom Widgets: Budget Editor */}
                  {phase.id === "phase_3" && (
                    <div style={{ padding: "16px", borderRadius: "10px", background: "#F8FAFC", border: "1px solid #E2E8F0", marginBottom: "20px" }}>
                      <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E293B", marginBottom: "8px" }}>
                        Budget Table Editor
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
                          📊 Edit Budget Table
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Phase 4 Custom Widgets: EoM Tasks */}
                  {phase.id === "phase_4" && (
                    <div style={{ padding: "16px", borderRadius: "10px", background: "#F8FAFC", border: "1px solid #E2E8F0", marginBottom: "20px" }}>
                      <span style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#1E293B", marginBottom: "8px" }}>
                        End-of-Month (EoM) Client Tasks (Task 28)
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
                          {applyingEomTasks ? "Applying Defaults..." : "📋 Seed / Re-apply Default EoM Tasks"}
                        </button>
                        <a
                          href={`/pma?nav=tasks&client=${encodeURIComponent(clientName)}`}
                          style={{
                            padding: "8px 14px",
                            borderRadius: "6px",
                            border: "none",
                            background: "#023f98",
                            color: "#FFFFFF",
                            fontWeight: "600",
                            fontSize: "12px",
                            textDecoration: "none",
                            display: "inline-block"
                          }}
                        >
                          Manage in EoM section →
                        </a>
                      </div>
                    </div>
                  )}

                  {/* Tasks List */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {phase.tasks.map((task) => (
                      <div
                        key={task.id}
                        style={{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: "12px",
                          padding: "10px 14px",
                          borderRadius: "8px",
                          background: task.isCompleted ? "#F0FDF4" : "#F8FAFC",
                          border: `1px solid ${task.isCompleted ? "#BBF7D0" : "#E2E8F0"}`
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={task.isCompleted}
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
                            {task.title}
                          </span>
                          {task.metadata && (
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
                    ))}
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
            Ready to Launch Live Dashboards?
          </h3>
          <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
            Completing setup will turn off Setup Mode and allow client users to access their live financial dashboards.
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
          <span>Complete Onboarding & Go Live →</span>
        </button>
      </div>
    </div>
  );
}
