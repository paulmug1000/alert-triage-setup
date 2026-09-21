import React, { createContext, useContext, useState } from 'react';
import { useTasks as useBaseTasks } from '../hooks/useTasks';

const TaskContext = createContext();

export function TaskProvider({ children, automationCommanderSheetId }) {
  const taskState = useBaseTasks();
  
  const [navTaskCount, setNavTaskCount] = useState(0);
  const [snoozedTaskCount, setSnoozedTaskCount] = useState(0);
  const [tasksLoadedAt, setTasksLoadedAt] = useState(0);

  const openCreateTaskModal = (alert, isProactive = false, isInfo = false) => {
    taskState.setTaskModalAlert(alert);
    taskState.setTaskModalIsProactive(isProactive);
    taskState.setTaskModalIsInfo(isInfo);
    taskState.setTaskModalNote("");
    taskState.setShowTaskModal(true);
    taskState.setTaskActionError("");
  };

  const loadTasks = async (filter = "active", bypassCache = false) => {
    try {
      taskState.setTasksLoading(true);
      taskState.setTaskActionError("");
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_tasks", automationCommanderSheetId, filter, bypassCache }),
      });
      const data = await res.json();
      if (data.success) {
        taskState.setTasks(data.tasks || []);
      } else {
        taskState.setTaskActionError(data.error || "Failed to load tasks");
      }
      
      // Always update timestamp to prevent infinite retry loops on API failure
      setTasksLoadedAt(Date.now());
      
      if (filter === "active" && data.success) {
        setNavTaskCount(data.tasks?.length || 0);
        fetch("/api/triage", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_tasks", automationCommanderSheetId, filter: "snoozed", bypassCache }),
        }).then(r => r.json()).then(d => { if (d.success) setSnoozedTaskCount(d.tasks?.length || 0); }).catch(() => {});
      }
      if (filter === "snoozed" && data.success) setSnoozedTaskCount(data.tasks?.length || 0);
    } catch (e) {
      taskState.setTaskActionError(e.message);
    } finally {
      taskState.setTasksLoading(false);
    }
  };

  const value = {
    ...taskState,
    navTaskCount, setNavTaskCount,
    snoozedTaskCount, setSnoozedTaskCount,
    tasksLoadedAt, setTasksLoadedAt,
    loadTasks, openCreateTaskModal
  };

  return (
    <TaskContext.Provider value={value}>
      {children}
    </TaskContext.Provider>
  );
}

export const useTasks = () => useContext(TaskContext);