import React, { useState, useEffect, useCallback, useMemo } from "react";
import Spinner from "./Spinner";

export default function EditSetupProcessView({ onBack, user, isAdmin }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const [phases, setPhases] = useState([]);
  const [tasks, setTasks] = useState([]);

  // Phase filter & search
  const [activePhaseFilter, setActivePhaseFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Add Step Modal state
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [addPhaseId, setAddPhaseId] = useState("phase_1");
  const [newStepTitle, setNewStepTitle] = useState("");
  const [newStepDescription, setNewStepDescription] = useState("");
  const [newStepAutoCompletable, setNewStepAutoCompletable] = useState(false);
  const [newStepPosition, setNewStepPosition] = useState("end");

  // Edit Step Modal state
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [editStepTitle, setEditStepTitle] = useState("");
  const [editStepPhaseId, setEditStepPhaseId] = useState("");
  const [editStepDescription, setEditStepDescription] = useState("");
  const [editStepAutoCompletable, setEditStepAutoCompletable] = useState(false);
  const [editStepActive, setEditStepActive] = useState(true);

  // Delete Confirmation Modal state
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [deletingTask, setDeletingTask] = useState(null);

  // Reset to Defaults Modal state
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);

  // Load template from API
  const loadTemplate = useCallback(async (force = false) => {
    setLoading(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/setup/process-template?force=${force ? "true" : "false"}`);
      const data = await res.json();
      if (data.success) {
        setPhases(data.phases || []);
        setTasks(data.tasks || []);
      } else {
        throw new Error(data.error || "Failed to load setup process template.");
      }
    } catch (err) {
      console.error("loadTemplate error:", err);
      setFeedback({ type: "error", message: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTemplate();
  }, [loadTemplate]);

  // Compute stats
  const totalStepsCount = tasks.length;
  const activeStepsCount = tasks.filter((t) => t.active !== false).length;
  const autoStepsCount = tasks.filter((t) => t.autoCompletable).length;

  // Group tasks by phase
  const groupedTasks = useMemo(() => {
    const map = new Map();
    phases.forEach((p) => map.set(p.id, []));
    tasks.forEach((t) => {
      if (map.has(t.phaseId)) {
        map.get(t.phaseId).push(t);
      } else {
        map.set(t.phaseId, [t]);
      }
    });
    // Sort within each phase by order
    map.forEach((list) => list.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)));
    return map;
  }, [phases, tasks]);

  // Move step up or down within its phase
  const handleMoveStep = async (task, direction) => {
    const phaseTasks = groupedTasks.get(task.phaseId) || [];
    const taskIndex = phaseTasks.findIndex((t) => t.id === task.id);

    if (direction === "up" && taskIndex <= 0) return;
    if (direction === "down" && taskIndex >= phaseTasks.length - 1) return;

    const targetIndex = direction === "up" ? taskIndex - 1 : taskIndex + 1;

    // Create a reordered copy of this phase's tasks
    const reorderedPhaseTasks = [...phaseTasks];
    const [moved] = reorderedPhaseTasks.splice(taskIndex, 1);
    reorderedPhaseTasks.splice(targetIndex, 0, moved);

    // Re-index all tasks in this phase to guarantee clean order numbers
    const phaseIndex = phases.findIndex((p) => p.id === task.phaseId);
    const baseOrder = ((phaseIndex >= 0 ? phaseIndex : 0) + 1) * 1000;
    const updatedPhaseTasks = reorderedPhaseTasks.map((t, idx) => ({
      ...t,
      order: baseOrder + (idx + 1) * 10
    }));

    const updatedTaskIds = new Set(updatedPhaseTasks.map((t) => t.id));
    const otherTasks = tasks.filter((t) => !updatedTaskIds.has(t.id));
    const allUpdatedTasks = [...otherTasks, ...updatedPhaseTasks].sort((a, b) => a.order - b.order);

    // Optimistically update state
    setTasks(allUpdatedTasks);
    setFeedback({ type: "success", message: `Step moved ${direction}.` });

    try {
      const res = await fetch("/api/setup/process-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save_all",
          phases,
          tasks: allUpdatedTasks
        })
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to persist step order.");
      }
    } catch (err) {
      console.error("handleMoveStep error:", err);
      setFeedback({ type: "error", message: `Failed to save order: ${err.message}` });
      loadTemplate(true);
    }
  };

  // Open Add Step modal
  const handleOpenAddModal = (phaseId = "phase_1") => {
    setAddPhaseId(phaseId);
    setNewStepTitle("");
    setNewStepDescription("");
    setNewStepAutoCompletable(false);
    setNewStepPosition("end");
    setIsAddModalOpen(true);
  };

  // Submit Add Step
  const handleSubmitAddStep = async (e) => {
    e.preventDefault();
    if (!newStepTitle.trim()) {
      setFeedback({ type: "error", message: "Step title is required." });
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/process-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add_step",
          phaseId: addPhaseId,
          title: newStepTitle.trim(),
          description: newStepDescription.trim(),
          autoCompletable: newStepAutoCompletable,
          position: newStepPosition
        })
      });
      const data = await res.json();
      if (data.success) {
        setPhases(data.phases || phases);
        setTasks(data.tasks || []);
        setIsAddModalOpen(false);
        setFeedback({ type: "success", message: `Step "${newStepTitle.trim()}" added successfully.` });
      } else {
        throw new Error(data.error || "Failed to add step.");
      }
    } catch (err) {
      console.error("handleSubmitAddStep error:", err);
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSaving(false);
    }
  };

  // Open Edit Step modal
  const handleOpenEditModal = (task) => {
    setEditingTask(task);
    setEditStepTitle(task.title || "");
    setEditStepPhaseId(task.phaseId || "phase_1");
    setEditStepDescription(task.description || "");
    setEditStepAutoCompletable(Boolean(task.autoCompletable));
    setEditStepActive(task.active !== false);
    setIsEditModalOpen(true);
  };

  // Submit Edit Step
  const handleSubmitEditStep = async (e) => {
    e.preventDefault();
    if (!editingTask || !editStepTitle.trim()) {
      setFeedback({ type: "error", message: "Step title is required." });
      return;
    }

    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/process-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_step",
          taskId: editingTask.id,
          phaseId: editStepPhaseId,
          title: editStepTitle.trim(),
          description: editStepDescription.trim(),
          autoCompletable: editStepAutoCompletable,
          active: editStepActive
        })
      });
      const data = await res.json();
      if (data.success) {
        setPhases(data.phases || phases);
        setTasks(data.tasks || []);
        setIsEditModalOpen(false);
        setEditingTask(null);
        setFeedback({ type: "success", message: `Step "${editStepTitle.trim()}" updated successfully.` });
      } else {
        throw new Error(data.error || "Failed to update step.");
      }
    } catch (err) {
      console.error("handleSubmitEditStep error:", err);
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSaving(false);
    }
  };

  // Open Delete Step confirmation
  const handleOpenDeleteModal = (task) => {
    setDeletingTask(task);
    setIsDeleteModalOpen(true);
  };

  // Confirm Delete Step
  const handleConfirmDeleteStep = async () => {
    if (!deletingTask) return;
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/process-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete_step",
          taskId: deletingTask.id
        })
      });
      const data = await res.json();
      if (data.success) {
        setPhases(data.phases || phases);
        setTasks(data.tasks || []);
        setIsDeleteModalOpen(false);
        setFeedback({ type: "success", message: `Step "${deletingTask.title}" removed from setup process.` });
        setDeletingTask(null);
      } else {
        throw new Error(data.error || "Failed to delete step.");
      }
    } catch (err) {
      console.error("handleConfirmDeleteStep error:", err);
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSaving(false);
    }
  };

  // Confirm Reset to Defaults
  const handleConfirmResetDefaults = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/setup/process-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset_defaults" })
      });
      const data = await res.json();
      if (data.success) {
        setPhases(data.phases || []);
        setTasks(data.tasks || []);
        setIsResetModalOpen(false);
        setFeedback({ type: "success", message: "Setup process reset to default phases and steps." });
      } else {
        throw new Error(data.error || "Failed to reset setup process.");
      }
    } catch (err) {
      console.error("handleConfirmResetDefaults error:", err);
      setFeedback({ type: "error", message: err.message });
    } finally {
      setSaving(false);
    }
  };

  // Filter phases to display
  const displayedPhases = useMemo(() => {
    if (activePhaseFilter === "all") return phases;
    return phases.filter((p) => p.id === activePhaseFilter);
  }, [phases, activePhaseFilter]);

  return (
    <div className="pma-page-container" style={{ width: "100%", maxWidth: "100%", margin: "0 auto", padding: "20px 32px 60px", boxSizing: "border-box" }}>
      {/* Top Breadcrumb & Navigation */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
        <button
          type="button"
          onClick={onBack}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            background: "transparent",
            border: "none",
            color: "#023f98",
            fontWeight: "700",
            fontSize: "13px",
            cursor: "pointer",
            padding: 0
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span>Back to setup</span>
        </button>

        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <button
            type="button"
            onClick={() => setIsResetModalOpen(true)}
            disabled={saving || loading}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "8px 14px",
              borderRadius: "8px",
              border: "1px solid #CBD5E1",
              background: "#FFFFFF",
              color: "#64748B",
              fontSize: "13px",
              fontWeight: "600",
              cursor: saving || loading ? "not-allowed" : "pointer",
              transition: "all 0.15s ease"
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
            <span>Reset to defaults</span>
          </button>

          <button
            type="button"
            onClick={() => handleOpenAddModal(phases[0]?.id || "phase_1")}
            disabled={saving || loading}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "8px 16px",
              borderRadius: "8px",
              border: "none",
              background: "#023f98",
              color: "#FFFFFF",
              fontSize: "13px",
              fontWeight: "700",
              cursor: saving || loading ? "not-allowed" : "pointer",
              boxShadow: "0 2px 4px rgba(2, 63, 152, 0.2)"
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>Add new step</span>
          </button>
        </div>
      </div>

      {/* Main Page Title */}
      <div style={{ marginBottom: "20px" }}>
        <h1 style={{ margin: "0 0 6px 0", fontSize: "24px", fontWeight: "700", color: "#0F172A", display: "flex", alignItems: "center", gap: "10px" }}>
          <span>Edit setup process</span>
        </h1>
        <p style={{ margin: 0, color: "#64748B", fontSize: "14px" }}>
          Customise onboarding phases, add or edit steps, and configure step order across all clients in setup mode.
        </p>
      </div>

      {/* Feedback Banner */}
      {feedback && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: "8px",
            marginBottom: "20px",
            fontSize: "13px",
            fontWeight: "500",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: feedback.type === "success" ? "#ECFDF5" : "#FEF2F2",
            border: `1px solid ${feedback.type === "success" ? "#A7F3D0" : "#FECACA"}`,
            color: feedback.type === "success" ? "#065F46" : "#991B1B"
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span>{feedback.type === "success" ? "✓" : "⚠️"}</span>
            <span>{feedback.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            style={{ background: "transparent", border: "none", cursor: "pointer", color: "inherit", fontSize: "14px" }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Stats Row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "14px", marginBottom: "20px" }}>
        <div style={{ background: "#FFFFFF", borderRadius: "10px", border: "1px solid #E2E8F0", padding: "14px 18px" }}>
          <span style={{ fontSize: "11px", fontWeight: "700", color: "#64748B", textTransform: "uppercase", letterSpacing: "0.5px" }}>
            Onboarding phases
          </span>
          <div style={{ fontSize: "22px", fontWeight: "800", color: "#0F172A", marginTop: "4px" }}>
            {phases.length}
          </div>
        </div>

        <div style={{ background: "#FFFFFF", borderRadius: "10px", border: "1px solid #E2E8F0", padding: "14px 18px" }}>
          <span style={{ fontSize: "11px", fontWeight: "700", color: "#64748B", textTransform: "uppercase", letterSpacing: "0.5px" }}>
            Total setup steps
          </span>
          <div style={{ fontSize: "22px", fontWeight: "800", color: "#0F172A", marginTop: "4px" }}>
            {activeStepsCount}
            {totalStepsCount > activeStepsCount && (
              <span style={{ fontSize: "12px", color: "#64748B", fontWeight: "500", marginLeft: "6px" }}>
                ({totalStepsCount - activeStepsCount} inactive)
              </span>
            )}
          </div>
        </div>

        <div style={{ background: "#FFFFFF", borderRadius: "10px", border: "1px solid #E2E8F0", padding: "14px 18px" }}>
          <span style={{ fontSize: "11px", fontWeight: "700", color: "#64748B", textTransform: "uppercase", letterSpacing: "0.5px" }}>
            Auto-completable steps
          </span>
          <div style={{ fontSize: "22px", fontWeight: "800", color: "#023f98", marginTop: "4px" }}>
            {autoStepsCount}
          </div>
        </div>
      </div>

      {/* Phase Filter Tabs & Search */}
      <div
        style={{
          background: "#FFFFFF",
          borderRadius: "12px 12px 0 0",
          border: "1px solid #E2E8F0",
          borderBottom: "none",
          padding: "16px 20px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px"
        }}
      >
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => setActivePhaseFilter("all")}
            style={{
              padding: "6px 14px",
              borderRadius: "20px",
              fontSize: "12px",
              fontWeight: "600",
              cursor: "pointer",
              border: activePhaseFilter === "all" ? "1px solid #023f98" : "1px solid #E2E8F0",
              background: activePhaseFilter === "all" ? "#023f98" : "#FFFFFF",
              color: activePhaseFilter === "all" ? "#FFFFFF" : "#475569"
            }}
          >
            All phases ({totalStepsCount})
          </button>
          {phases.map((phase) => {
            const count = (groupedTasks.get(phase.id) || []).length;
            const isSelected = activePhaseFilter === phase.id;
            return (
              <button
                key={phase.id}
                type="button"
                onClick={() => setActivePhaseFilter(phase.id)}
                style={{
                  padding: "6px 14px",
                  borderRadius: "20px",
                  fontSize: "12px",
                  fontWeight: "600",
                  cursor: "pointer",
                  border: isSelected ? "1px solid #023f98" : "1px solid #E2E8F0",
                  background: isSelected ? "#EFF6FF" : "#FFFFFF",
                  color: isSelected ? "#023f98" : "#475569"
                }}
              >
                {phase.title.split(".")[0]?.trim() || phase.id} ({count})
              </button>
            );
          })}
        </div>

        <div style={{ minWidth: "240px" }}>
          <input
            type="text"
            placeholder="Search setup steps..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: "100%",
              padding: "7px 12px",
              borderRadius: "6px",
              border: "1px solid #CBD5E1",
              fontSize: "13px",
              boxSizing: "border-box"
            }}
          />
        </div>
      </div>

      {/* Main Phases & Steps Container */}
      {loading ? (
        <div style={{ background: "#FFFFFF", borderRadius: "0 0 12px 12px", border: "1px solid #E2E8F0", padding: "60px 20px", textAlign: "center" }}>
          <Spinner size={28} color="#023f98" />
          <p style={{ marginTop: "12px", color: "#64748B", fontSize: "14px", fontWeight: "500" }}>
            Loading setup process template...
          </p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginTop: "-1px" }}>
          {displayedPhases.map((phase) => {
            const phaseTasks = groupedTasks.get(phase.id) || [];
            const filteredTasks = searchQuery.trim()
              ? phaseTasks.filter((t) =>
                  t.title.toLowerCase().includes(searchQuery.toLowerCase().trim()) ||
                  (t.description && t.description.toLowerCase().includes(searchQuery.toLowerCase().trim()))
                )
              : phaseTasks;

            return (
              <div
                key={phase.id}
                style={{
                  background: "#FFFFFF",
                  borderRadius: "12px",
                  border: "1px solid #E2E8F0",
                  overflow: "hidden",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.03)"
                }}
              >
                {/* Phase Header */}
                <div
                  style={{
                    padding: "16px 20px",
                    background: "#F8FAFC",
                    borderBottom: "1px solid #E2E8F0",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "10px"
                  }}
                >
                  <div>
                    <h2 style={{ margin: "0 0 3px", fontSize: "16px", fontWeight: "700", color: "#0F172A" }}>
                      {phase.title}
                    </h2>
                    <p style={{ margin: 0, fontSize: "12px", color: "#64748B" }}>
                      {phase.description}
                    </p>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <span
                      style={{
                        fontSize: "12px",
                        fontWeight: "700",
                        padding: "3px 10px",
                        borderRadius: "12px",
                        background: "#E2E8F0",
                        color: "#334155"
                      }}
                    >
                      {phaseTasks.length} {phaseTasks.length === 1 ? "step" : "steps"}
                    </span>

                    <button
                      type="button"
                      onClick={() => handleOpenAddModal(phase.id)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        padding: "6px 12px",
                        borderRadius: "6px",
                        border: "1px solid #CBD5E1",
                        background: "#FFFFFF",
                        color: "#023f98",
                        fontWeight: "700",
                        fontSize: "12px",
                        cursor: "pointer",
                        transition: "all 0.15s ease"
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      <span>Add step</span>
                    </button>
                  </div>
                </div>

                {/* Phase Steps List */}
                <div style={{ padding: "16px 20px" }}>
                  {filteredTasks.length === 0 ? (
                    <div style={{ padding: "24px", textAlign: "center", color: "#94A3B8", fontSize: "13px" }}>
                      {searchQuery.trim() ? "No steps match your search query." : "No steps in this phase yet."}
                    </div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                      {filteredTasks.map((task, idx) => {
                        const isFirst = idx === 0;
                        const isLast = idx === filteredTasks.length - 1;

                        return (
                          <div
                            key={task.id}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: "12px",
                              padding: "12px 16px",
                              borderRadius: "8px",
                              border: "1px solid #E2E8F0",
                              background: task.active === false ? "#F8FAFC" : "#FFFFFF",
                              transition: "background 0.15s ease",
                              opacity: task.active === false ? 0.75 : 1
                            }}
                          >
                            {/* Reordering Up / Down buttons & Position pill */}
                            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                                <button
                                  type="button"
                                  onClick={() => handleMoveStep(task, "up")}
                                  disabled={isFirst}
                                  title="Move up"
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    width: "22px",
                                    height: "20px",
                                    borderRadius: "4px",
                                    border: "1px solid #E2E8F0",
                                    background: isFirst ? "#F1F5F9" : "#FFFFFF",
                                    color: isFirst ? "#CBD5E1" : "#475569",
                                    cursor: isFirst ? "not-allowed" : "pointer",
                                    fontSize: "10px",
                                    padding: 0
                                  }}
                                >
                                  ▲
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleMoveStep(task, "down")}
                                  disabled={isLast}
                                  title="Move down"
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    width: "22px",
                                    height: "20px",
                                    borderRadius: "4px",
                                    border: "1px solid #E2E8F0",
                                    background: isLast ? "#F1F5F9" : "#FFFFFF",
                                    color: isLast ? "#CBD5E1" : "#475569",
                                    cursor: isLast ? "not-allowed" : "pointer",
                                    fontSize: "10px",
                                    padding: 0
                                  }}
                                >
                                  ▼
                                </button>
                              </div>

                              <span
                                style={{
                                  fontSize: "12px",
                                  fontWeight: "700",
                                  color: "#64748B",
                                  background: "#F1F5F9",
                                  padding: "3px 8px",
                                  borderRadius: "6px",
                                  minWidth: "24px",
                                  textAlign: "center"
                                }}
                              >
                                #{idx + 1}
                              </span>
                            </div>

                            {/* Step Title & Guidance Notes */}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                                <span style={{ fontSize: "14px", fontWeight: "600", color: "#1E293B" }}>
                                  {task.title}
                                </span>

                                {task.autoCompletable && (
                                  <span
                                    style={{
                                      fontSize: "10px",
                                      fontWeight: "700",
                                      padding: "2px 7px",
                                      borderRadius: "6px",
                                      background: "#EFF6FF",
                                      color: "#1E40AF",
                                      border: "1px solid #BFDBFE"
                                    }}
                                  >
                                    Auto-completable
                                  </span>
                                )}

                                {task.active === false && (
                                  <span
                                    style={{
                                      fontSize: "10px",
                                      fontWeight: "700",
                                      padding: "2px 7px",
                                      borderRadius: "6px",
                                      background: "#FFFBEB",
                                      color: "#B45309",
                                      border: "1px solid #FDE68A"
                                    }}
                                  >
                                    Inactive
                                  </span>
                                )}
                              </div>

                              {task.description && (
                                <p style={{ margin: "4px 0 0", fontSize: "12px", color: "#64748B", lineHeight: "1.4" }}>
                                  {task.description}
                                </p>
                              )}
                            </div>

                            {/* Actions on Step */}
                            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                              <button
                                type="button"
                                onClick={() => handleOpenEditModal(task)}
                                style={{
                                  padding: "6px 12px",
                                  borderRadius: "6px",
                                  border: "1px solid #CBD5E1",
                                  background: "#FFFFFF",
                                  color: "#334155",
                                  fontSize: "12px",
                                  fontWeight: "600",
                                  cursor: "pointer",
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "5px"
                                }}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M12 20h9" />
                                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                                </svg>
                                <span>Edit</span>
                              </button>

                              <button
                                type="button"
                                onClick={() => handleOpenDeleteModal(task)}
                                style={{
                                  padding: "6px 10px",
                                  borderRadius: "6px",
                                  border: "1px solid #FCA5A5",
                                  background: "#FFF5F5",
                                  color: "#DC2626",
                                  fontSize: "12px",
                                  fontWeight: "600",
                                  cursor: "pointer",
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "4px"
                                }}
                              >
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="3 6 5 6 21 6" />
                                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                </svg>
                                <span>Delete</span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ======================================================================
          MODAL 1: ADD NEW STEP
      ====================================================================== */}
      {isAddModalOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(15, 23, 42, 0.55)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "16px"
          }}
          onClick={() => !saving && setIsAddModalOpen(false)}
        >
          <div
            style={{
              background: "#FFFFFF",
              borderRadius: "12px",
              maxWidth: "520px",
              width: "100%",
              padding: "24px",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "18px" }}>
              <h2 style={{ margin: 0, fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>
                Add new step
              </h2>
              <button
                type="button"
                onClick={() => setIsAddModalOpen(false)}
                disabled={saving}
                style={{ background: "transparent", border: "none", fontSize: "18px", cursor: "pointer", color: "#64748B" }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitAddStep}>
              <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginBottom: "22px" }}>
                {/* Phase Selection */}
                <div>
                  <label htmlFor="add-step-phase" style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                    Phase
                  </label>
                  <select
                    id="add-step-phase"
                    value={addPhaseId}
                    onChange={(e) => setAddPhaseId(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "9px 12px",
                      borderRadius: "8px",
                      border: "1px solid #CBD5E1",
                      fontSize: "13px",
                      background: "#FFFFFF",
                      color: "#1E293B",
                      cursor: "pointer",
                      boxSizing: "border-box"
                    }}
                  >
                    {phases.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Step Title */}
                <div>
                  <label htmlFor="add-step-title" style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                    Step title <span style={{ color: "#DC2626" }}>*</span>
                  </label>
                  <input
                    id="add-step-title"
                    type="text"
                    placeholder="e.g. Verify VAT registration number"
                    value={newStepTitle}
                    onChange={(e) => setNewStepTitle(e.target.value)}
                    required
                    style={{
                      width: "100%",
                      padding: "9px 12px",
                      borderRadius: "8px",
                      border: "1px solid #CBD5E1",
                      fontSize: "13px",
                      boxSizing: "border-box"
                    }}
                  />
                </div>

                {/* Guidance Notes */}
                <div>
                  <label htmlFor="add-step-desc" style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                    Guidance notes (optional)
                  </label>
                  <textarea
                    id="add-step-desc"
                    placeholder="Instructions or details explaining what needs to be checked or completed..."
                    value={newStepDescription}
                    onChange={(e) => setNewStepDescription(e.target.value)}
                    rows={3}
                    style={{
                      width: "100%",
                      padding: "9px 12px",
                      borderRadius: "8px",
                      border: "1px solid #CBD5E1",
                      fontSize: "13px",
                      boxSizing: "border-box",
                      fontFamily: "inherit"
                    }}
                  />
                </div>

                {/* Position in phase */}
                <div>
                  <label htmlFor="add-step-position" style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                    Position in phase
                  </label>
                  <select
                    id="add-step-position"
                    value={newStepPosition}
                    onChange={(e) => setNewStepPosition(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "9px 12px",
                      borderRadius: "8px",
                      border: "1px solid #CBD5E1",
                      fontSize: "13px",
                      background: "#FFFFFF",
                      color: "#1E293B",
                      cursor: "pointer",
                      boxSizing: "border-box"
                    }}
                  >
                    <option value="end">At the end of this phase</option>
                    <option value="start">At the beginning of this phase</option>
                  </select>
                </div>

                {/* Auto-completable Checkbox */}
                <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", borderRadius: "8px", background: "#F8FAFC", border: "1px solid #E2E8F0" }}>
                  <input
                    id="add-step-auto"
                    type="checkbox"
                    checked={newStepAutoCompletable}
                    onChange={(e) => setNewStepAutoCompletable(e.target.checked)}
                    style={{ width: "16px", height: "16px", cursor: "pointer" }}
                  />
                  <div>
                    <label htmlFor="add-step-auto" style={{ fontSize: "13px", fontWeight: "600", color: "#1E293B", cursor: "pointer" }}>
                      Auto-completable step
                    </label>
                    <p style={{ margin: 0, fontSize: "11px", color: "#64748B" }}>
                      Check if this step is verified automatically by system integrations or API connectors.
                    </p>
                  </div>
                </div>
              </div>

              {/* Modal Footer */}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  disabled={saving}
                  style={{
                    padding: "9px 16px",
                    borderRadius: "8px",
                    border: "1px solid #CBD5E1",
                    background: "#FFFFFF",
                    color: "#475569",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: saving ? "not-allowed" : "pointer"
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  style={{
                    padding: "9px 20px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#023f98",
                    color: "#FFFFFF",
                    fontSize: "13px",
                    fontWeight: "700",
                    cursor: saving ? "wait" : "pointer",
                    boxShadow: "0 2px 4px rgba(2, 63, 152, 0.2)"
                  }}
                >
                  {saving ? "Adding step..." : "Add step"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================================
          MODAL 2: EDIT STEP
      ====================================================================== */}
      {isEditModalOpen && editingTask && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(15, 23, 42, 0.55)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "16px"
          }}
          onClick={() => !saving && setIsEditModalOpen(false)}
        >
          <div
            style={{
              background: "#FFFFFF",
              borderRadius: "12px",
              maxWidth: "520px",
              width: "100%",
              padding: "24px",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "18px" }}>
              <h2 style={{ margin: 0, fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>
                Edit step
              </h2>
              <button
                type="button"
                onClick={() => setIsEditModalOpen(false)}
                disabled={saving}
                style={{ background: "transparent", border: "none", fontSize: "18px", cursor: "pointer", color: "#64748B" }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmitEditStep}>
              <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginBottom: "22px" }}>
                {/* Phase Selection */}
                <div>
                  <label htmlFor="edit-step-phase" style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                    Phase
                  </label>
                  <select
                    id="edit-step-phase"
                    value={editStepPhaseId}
                    onChange={(e) => setEditStepPhaseId(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "9px 12px",
                      borderRadius: "8px",
                      border: "1px solid #CBD5E1",
                      fontSize: "13px",
                      background: "#FFFFFF",
                      color: "#1E293B",
                      cursor: "pointer",
                      boxSizing: "border-box"
                    }}
                  >
                    {phases.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Step Title */}
                <div>
                  <label htmlFor="edit-step-title" style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                    Step title <span style={{ color: "#DC2626" }}>*</span>
                  </label>
                  <input
                    id="edit-step-title"
                    type="text"
                    value={editStepTitle}
                    onChange={(e) => setEditStepTitle(e.target.value)}
                    required
                    style={{
                      width: "100%",
                      padding: "9px 12px",
                      borderRadius: "8px",
                      border: "1px solid #CBD5E1",
                      fontSize: "13px",
                      boxSizing: "border-box"
                    }}
                  />
                </div>

                {/* Guidance Notes */}
                <div>
                  <label htmlFor="edit-step-desc" style={{ display: "block", fontSize: "13px", fontWeight: "700", color: "#334155", marginBottom: "6px" }}>
                    Guidance notes
                  </label>
                  <textarea
                    id="edit-step-desc"
                    value={editStepDescription}
                    onChange={(e) => setEditStepDescription(e.target.value)}
                    rows={3}
                    style={{
                      width: "100%",
                      padding: "9px 12px",
                      borderRadius: "8px",
                      border: "1px solid #CBD5E1",
                      fontSize: "13px",
                      boxSizing: "border-box",
                      fontFamily: "inherit"
                    }}
                  />
                </div>

                {/* Auto-completable Checkbox */}
                <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", borderRadius: "8px", background: "#F8FAFC", border: "1px solid #E2E8F0" }}>
                  <input
                    id="edit-step-auto"
                    type="checkbox"
                    checked={editStepAutoCompletable}
                    onChange={(e) => setEditStepAutoCompletable(e.target.checked)}
                    style={{ width: "16px", height: "16px", cursor: "pointer" }}
                  />
                  <div>
                    <label htmlFor="edit-step-auto" style={{ fontSize: "13px", fontWeight: "600", color: "#1E293B", cursor: "pointer" }}>
                      Auto-completable step
                    </label>
                    <p style={{ margin: 0, fontSize: "11px", color: "#64748B" }}>
                      Check if this step is verified automatically by system integrations or API connectors.
                    </p>
                  </div>
                </div>

                {/* Active Checkbox */}
                <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", borderRadius: "8px", background: "#F8FAFC", border: "1px solid #E2E8F0" }}>
                  <input
                    id="edit-step-active"
                    type="checkbox"
                    checked={editStepActive}
                    onChange={(e) => setEditStepActive(e.target.checked)}
                    style={{ width: "16px", height: "16px", cursor: "pointer" }}
                  />
                  <div>
                    <label htmlFor="edit-step-active" style={{ fontSize: "13px", fontWeight: "600", color: "#1E293B", cursor: "pointer" }}>
                      Active in client onboarding
                    </label>
                    <p style={{ margin: 0, fontSize: "11px", color: "#64748B" }}>
                      When inactive, this step is hidden from the onboarding checklist for clients.
                    </p>
                  </div>
                </div>
              </div>

              {/* Modal Footer */}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                <button
                  type="button"
                  onClick={() => setIsEditModalOpen(false)}
                  disabled={saving}
                  style={{
                    padding: "9px 16px",
                    borderRadius: "8px",
                    border: "1px solid #CBD5E1",
                    background: "#FFFFFF",
                    color: "#475569",
                    fontSize: "13px",
                    fontWeight: "600",
                    cursor: saving ? "not-allowed" : "pointer"
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  style={{
                    padding: "9px 20px",
                    borderRadius: "8px",
                    border: "none",
                    background: "#023f98",
                    color: "#FFFFFF",
                    fontSize: "13px",
                    fontWeight: "700",
                    cursor: saving ? "wait" : "pointer",
                    boxShadow: "0 2px 4px rgba(2, 63, 152, 0.2)"
                  }}
                >
                  {saving ? "Saving changes..." : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================================
          MODAL 3: DELETE STEP CONFIRMATION
      ====================================================================== */}
      {isDeleteModalOpen && deletingTask && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(15, 23, 42, 0.55)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "16px"
          }}
          onClick={() => !saving && setIsDeleteModalOpen(false)}
        >
          <div
            style={{
              background: "#FFFFFF",
              borderRadius: "12px",
              maxWidth: "460px",
              width: "100%",
              padding: "24px",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "14px" }}>
              <div
                style={{
                  width: "40px",
                  height: "40px",
                  borderRadius: "20px",
                  background: "#FEE2E2",
                  color: "#DC2626",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "18px"
                }}
              >
                ⚠️
              </div>
              <h2 style={{ margin: 0, fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>
                Confirm step deletion
              </h2>
            </div>

            <p style={{ margin: "0 0 16px", fontSize: "14px", color: "#475569", lineHeight: "1.5" }}>
              Are you sure you want to remove this step from the setup process?
            </p>

            <div style={{ padding: "12px 14px", borderRadius: "8px", background: "#F8FAFC", border: "1px solid #E2E8F0", marginBottom: "20px" }}>
              <span style={{ fontSize: "13px", fontWeight: "700", color: "#0F172A" }}>
                {deletingTask.title}
              </span>
              {deletingTask.description && (
                <p style={{ margin: "4px 0 0", fontSize: "12px", color: "#64748B" }}>
                  {deletingTask.description}
                </p>
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button
                type="button"
                onClick={() => setIsDeleteModalOpen(false)}
                disabled={saving}
                style={{
                  padding: "9px 16px",
                  borderRadius: "8px",
                  border: "1px solid #CBD5E1",
                  background: "#FFFFFF",
                  color: "#475569",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: saving ? "not-allowed" : "pointer"
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteStep}
                disabled={saving}
                style={{
                  padding: "9px 18px",
                  borderRadius: "8px",
                  border: "none",
                  background: "#DC2626",
                  color: "#FFFFFF",
                  fontSize: "13px",
                  fontWeight: "700",
                  cursor: saving ? "wait" : "pointer",
                  boxShadow: "0 2px 4px rgba(220, 38, 38, 0.2)"
                }}
              >
                {saving ? "Deleting..." : "Delete step"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================================
          MODAL 4: RESET TO DEFAULTS CONFIRMATION
      ====================================================================== */}
      {isResetModalOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(15, 23, 42, 0.55)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "16px"
          }}
          onClick={() => !saving && setIsResetModalOpen(false)}
        >
          <div
            style={{
              background: "#FFFFFF",
              borderRadius: "12px",
              maxWidth: "460px",
              width: "100%",
              padding: "24px",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "14px" }}>
              <div
                style={{
                  width: "40px",
                  height: "40px",
                  borderRadius: "20px",
                  background: "#FEF3C7",
                  color: "#B45309",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "18px"
                }}
              >
                ↺
              </div>
              <h2 style={{ margin: 0, fontSize: "18px", fontWeight: "700", color: "#0F172A" }}>
                Reset setup process
              </h2>
            </div>

            <p style={{ margin: "0 0 20px", fontSize: "14px", color: "#475569", lineHeight: "1.5" }}>
              Are you sure you want to reset the setup process back to standard defaults? Any custom steps or modified step orders will be replaced with the default 5 phases and 27 steps.
            </p>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button
                type="button"
                onClick={() => setIsResetModalOpen(false)}
                disabled={saving}
                style={{
                  padding: "9px 16px",
                  borderRadius: "8px",
                  border: "1px solid #CBD5E1",
                  background: "#FFFFFF",
                  color: "#475569",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: saving ? "not-allowed" : "pointer"
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmResetDefaults}
                disabled={saving}
                style={{
                  padding: "9px 18px",
                  borderRadius: "8px",
                  border: "none",
                  background: "#B45309",
                  color: "#FFFFFF",
                  fontSize: "13px",
                  fontWeight: "700",
                  cursor: saving ? "wait" : "pointer",
                  boxShadow: "0 2px 4px rgba(180, 83, 9, 0.2)"
                }}
              >
                {saving ? "Resetting..." : "Reset to defaults"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
