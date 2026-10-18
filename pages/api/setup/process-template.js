/**
 * ============================================================================
 * SETUP PROCESS TEMPLATE API: /api/setup/process-template
 * ============================================================================
 *
 * GET: Retrieves the master setup process template (phases and ordered steps).
 * POST: Updates setup process template (save all, add step, edit step, delete step, reset defaults).
 * Strictly restricted to Admins.
 */

import { getSessionUser } from "../../../services/authService.js";
import { getSheetsClient } from "../../../services/sheetsClient.js";
import {
  getSetupProcessTemplate,
  saveSetupProcessTemplate,
  seedDefaultSetupProcessTemplate
} from "../../../services/setupService.js";

export default async function handler(req, res) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    return res.status(401).json({ success: false, error: "Active session required." });
  }

  // Admin role check (Admins only)
  const isUserAdmin = Boolean(!sessionUser.isReadOnly && (sessionUser.isAdmin || sessionUser.role === "Admin"));
  if (!isUserAdmin) {
    return res.status(403).json({ success: false, error: "Access denied: Setup process configuration requires admin privileges." });
  }

  const sheets = await getSheetsClient();

  if (req.method === "GET") {
    try {
      const force = req.query.force === "true";
      const template = await getSetupProcessTemplate(sheets, force);
      return res.status(200).json({ success: true, ...template });
    } catch (err) {
      console.error("GET /api/setup/process-template error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
    const { action } = req.body || {};

    try {
      // 1. Reset to system defaults
      if (action === "reset_defaults") {
        const resetTemplate = await seedDefaultSetupProcessTemplate(sheets, sessionUser.email);
        return res.status(200).json({ success: true, ...resetTemplate });
      }

      // 2. Save full template
      if (action === "save_all") {
        const { phases, tasks } = req.body;
        if (!Array.isArray(tasks) || !Array.isArray(phases)) {
          return res.status(400).json({ success: false, error: "Missing phases or tasks array." });
        }
        const updated = await saveSetupProcessTemplate(sheets, { phases, tasks }, sessionUser.email);
        return res.status(200).json({ success: true, ...updated });
      }

      // 3. Add new step
      if (action === "add_step") {
        const { phaseId, title, description, autoCompletable, position } = req.body;
        if (!phaseId || !title || !String(title).trim()) {
          return res.status(400).json({ success: false, error: "Phase and step title are required." });
        }

        const currentTemplate = await getSetupProcessTemplate(sheets);
        const phases = currentTemplate.phases || [];
        const existingTasks = currentTemplate.tasks || [];

        const newId = `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const newTask = {
          id: newId,
          phaseId,
          title: String(title).trim(),
          description: String(description || "").trim(),
          autoCompletable: Boolean(autoCompletable),
          active: true
        };

        // Separate tasks by phase to preserve order and cleanly position the new task
        const phaseTasks = existingTasks.filter(t => t.phaseId === phaseId);
        if (position === "start") {
          phaseTasks.unshift(newTask);
        } else {
          phaseTasks.push(newTask);
        }

        const otherTasks = existingTasks.filter(t => t.phaseId !== phaseId);

        // Re-index all tasks sequentially
        const phaseOrderMap = new Map(phases.map((p, idx) => [p.id, idx + 1]));
        const reorderedTasks = [];

        phases.forEach((p, pIdx) => {
          const tasksInP = p.id === phaseId ? phaseTasks : otherTasks.filter(t => t.phaseId === p.id);
          const baseOrder = (pIdx + 1) * 1000;
          tasksInP.forEach((t, tIdx) => {
            reorderedTasks.push({
              ...t,
              order: baseOrder + (tIdx + 1) * 10
            });
          });
        });

        const updated = await saveSetupProcessTemplate(sheets, { phases, tasks: reorderedTasks }, sessionUser.email);
        return res.status(200).json({ success: true, addedTaskId: newId, ...updated });
      }

      // 4. Update existing step
      if (action === "update_step") {
        const { taskId, phaseId, title, description, autoCompletable, active } = req.body;
        if (!taskId) {
          return res.status(400).json({ success: false, error: "Missing taskId." });
        }

        const currentTemplate = await getSetupProcessTemplate(sheets);
        const phases = currentTemplate.phases || [];
        let tasks = currentTemplate.tasks || [];

        const taskIndex = tasks.findIndex(t => t.id === taskId);
        if (taskIndex === -1) {
          return res.status(404).json({ success: false, error: "Step not found." });
        }

        const existingTask = tasks[taskIndex];
        const updatedTask = {
          ...existingTask,
          phaseId: phaseId || existingTask.phaseId,
          title: title !== undefined ? String(title).trim() : existingTask.title,
          description: description !== undefined ? String(description).trim() : (existingTask.description || ""),
          autoCompletable: autoCompletable !== undefined ? Boolean(autoCompletable) : existingTask.autoCompletable,
          active: active !== undefined ? Boolean(active) : (existingTask.active !== false)
        };

        // If phase changed, move to the end of the new phase
        if (phaseId && phaseId !== existingTask.phaseId) {
          const remainingTasks = tasks.filter(t => t.id !== taskId);
          const newPhaseTasks = remainingTasks.filter(t => t.phaseId === phaseId);
          const phaseIndex = phases.findIndex(p => p.id === phaseId);
          const baseOrder = ((phaseIndex >= 0 ? phaseIndex : 0) + 1) * 1000;
          updatedTask.order = baseOrder + (newPhaseTasks.length + 1) * 10;
          tasks = [...remainingTasks, updatedTask].sort((a, b) => a.order - b.order);
        } else {
          tasks[taskIndex] = updatedTask;
        }

        const updated = await saveSetupProcessTemplate(sheets, { phases, tasks }, sessionUser.email);
        return res.status(200).json({ success: true, ...updated });
      }

      // 5. Delete step
      if (action === "delete_step") {
        const { taskId } = req.body;
        if (!taskId) {
          return res.status(400).json({ success: false, error: "Missing taskId." });
        }

        const currentTemplate = await getSetupProcessTemplate(sheets);
        const phases = currentTemplate.phases || [];
        const tasks = (currentTemplate.tasks || []).filter(t => t.id !== taskId);

        const updated = await saveSetupProcessTemplate(sheets, { phases, tasks }, sessionUser.email);
        return res.status(200).json({ success: true, deletedTaskId: taskId, ...updated });
      }

      return res.status(400).json({ success: false, error: "Invalid action specified." });
    } catch (err) {
      console.error("POST /api/setup/process-template error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed." });
}
