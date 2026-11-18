import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useTasks as useBaseTasks } from '../hooks/useTasks';

const TaskContext = createContext();

export function TaskProvider({ children, automationCommanderSheetId, managedClient }) {
  const taskState = useBaseTasks();
  const inFlightLoadRef = useRef(null);
  const inFlightCountRef = useRef(null);
  const lastFetchedAtRef = useRef(0);

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

  const applyCountsFromResponse_ = useCallback((data) => {
    if (data?.counts) {
      setNavTaskCount(data.counts.active || 0);
      setSnoozedTaskCount(data.counts.snoozed || 0);
      setOtherActiveTaskCount(data.counts.otherActive || 0);
      setOtherSnoozedTaskCount(data.counts.otherSnoozed || 0);
      setResolvedTaskCount(data.counts.resolved || 0);
    } else if (Array.isArray(data?.tasks)) {
      setNavTaskCount(data.tasks.length);
    }
  }, []);

  const refreshTaskCount = useCallback(async (bypassCache = false) => {
    if (!automationCommanderSheetId) return;
    if (!bypassCache && inFlightLoadRef.current) {
      return inFlightLoadRef.current;
    }
    if (!bypassCache && Date.now() - lastFetchedAtRef.current < 5000) {
      return;
    }
    if (inFlightCountRef.current && !bypassCache) {
      return inFlightCountRef.current;
    }
    const p = (async () => {
      try {
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "get_tasks",
            automationCommanderSheetId,
            filter: "active",
            clientName: managedClient?.clientName || "",
            bypassCache,
            countsOnly: true
          }),
        });
        const data = await res.json();
        if (data.success) {
          applyCountsFromResponse_(data);
          lastFetchedAtRef.current = Date.now();
        }
      } catch (e) {
        console.error("Failed to load task counts:", e);
      } finally {
        if (inFlightCountRef.current === p) inFlightCountRef.current = null;
      }
    })();
    inFlightCountRef.current = p;
    return p;
  }, [automationCommanderSheetId, managedClient?.clientName, applyCountsFromResponse_]);

  const {
    tasksFilter,
    setTasks,
    setTasksLoading,
    setTaskActionError
  } = taskState;

  const loadTasks = useCallback(async (filter = "active", bypassCache = false) => {
    const reqKey = `${automationCommanderSheetId || ""}:${filter || "active"}:${managedClient?.clientName || ""}`;
    if (!bypassCache && inFlightLoadRef.current && inFlightLoadRef.current._reqKey === reqKey) {
      return inFlightLoadRef.current;
    }
    const p = (async () => {
      try {
        setTasksLoading(true);
        setTaskActionError("");
        const res = await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "get_tasks",
            automationCommanderSheetId,
            filter,
            clientName: managedClient?.clientName || "",
            bypassCache
          }),
        });
        const data = await res.json();
        if (data.success) {
          setTasks(data.tasks || []);
          applyCountsFromResponse_(data);
          lastFetchedAtRef.current = Date.now();
        } else {
          setTaskActionError(data.error || "Failed to load tasks");
        }

        // Always update timestamp to prevent infinite retry loops on API failure
        setTasksLoadedAt(Date.now());
      } catch (e) {
        setTaskActionError(e.message);
      } finally {
        setTasksLoading(false);
        if (inFlightLoadRef.current === p) inFlightLoadRef.current = null;
      }
    })();
    p._reqKey = reqKey;
    inFlightLoadRef.current = p;
    return p;
  }, [automationCommanderSheetId, managedClient?.clientName, setTasks, setTasksLoading, setTaskActionError, applyCountsFromResponse_]);

  useEffect(() => {
    if (automationCommanderSheetId) {
      loadTasks(tasksFilter || "active", false);
    }
  }, [automationCommanderSheetId, managedClient?.clientName, loadTasks, tasksFilter]);

  useEffect(() => {
    const interval = setInterval(() => {
      refreshTaskCount(false);
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [automationCommanderSheetId, refreshTaskCount]);

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