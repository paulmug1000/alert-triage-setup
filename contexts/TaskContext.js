import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useTasks as useBaseTasks } from '../hooks/useTasks';

const TaskContext = createContext();

export function TaskProvider({ children, automationCommanderSheetId }) {
  const taskState = useBaseTasks();
  
  const [navTaskCount, setNavTaskCount] = useState(0);
  const [snoozedTaskCount, setSnoozedTaskCount] = useState(0);
  const [otherActiveTaskCount, setOtherActiveTaskCount] = useState(0);
  const [otherSnoozedTaskCount, setOtherSnoozedTaskCount] = useState(0);
  const [resolvedTaskCount, setResolvedTaskCount] = useState(0);
  const [tasksLoadedAt, setTasksLoadedAt] = useState(0);

  const openCreateTaskModal = (alert, isProactive = false, isInfo = false) => {
    taskState.setTaskModalAlert(alert);
    taskState.setTaskModalIsProactive(isProactive);
    taskState.setTaskModalIsInfo(isInfo);
    taskState.setTaskModalNote("");
    taskState.setShowTaskModal(true);
    taskState.setTaskActionError("");
  };

  const refreshTaskCount = useCallback(async (bypassCache = false) => {
    if (!automationCommanderSheetId) return;
    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_tasks", automationCommanderSheetId, filter: "active", bypassCache }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.counts) {
          setNavTaskCount(data.counts.active || 0);
          setSnoozedTaskCount(data.counts.snoozed || 0);
          setOtherActiveTaskCount(data.counts.otherActive || 0);
          setOtherSnoozedTaskCount(data.counts.otherSnoozed || 0);
          setResolvedTaskCount(data.counts.resolved || 0);
        } else if (Array.isArray(data.tasks)) {
          setNavTaskCount(data.tasks.length);
        }
      }
    } catch (e) {
      console.error("Failed to load task counts:", e);
    }
  }, [automationCommanderSheetId]);

  useEffect(() => {
    if (automationCommanderSheetId) {
      refreshTaskCount();
    }
    const interval = setInterval(() => {
      refreshTaskCount();
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [automationCommanderSheetId, refreshTaskCount]);

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
        if (data.counts) {
          setNavTaskCount(data.counts.active || 0);
          setSnoozedTaskCount(data.counts.snoozed || 0);
          setOtherActiveTaskCount(data.counts.otherActive || 0);
          setOtherSnoozedTaskCount(data.counts.otherSnoozed || 0);
          setResolvedTaskCount(data.counts.resolved || 0);
        }
      } else {
        taskState.setTaskActionError(data.error || "Failed to load tasks");
      }
      
      // Always update timestamp to prevent infinite retry loops on API failure
      setTasksLoadedAt(Date.now());
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
    otherActiveTaskCount, setOtherActiveTaskCount,
    otherSnoozedTaskCount, setOtherSnoozedTaskCount,
    resolvedTaskCount, setResolvedTaskCount,
    tasksLoadedAt, setTasksLoadedAt,
    loadTasks, openCreateTaskModal,
    refreshTaskCount
  };

  return (
    <TaskContext.Provider value={value}>
      {children}
    </TaskContext.Provider>
  );
}

export const useTasks = () => useContext(TaskContext);