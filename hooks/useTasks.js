import { useState } from "react";

export function useTasks() {
  const [tasks, setTasks] = useState([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [tasksFilter, setTasksFilter] = useState("active");
  const [selectedTask, setSelectedTask] = useState(null);
  const [taskDetailOptions, setTaskDetailOptions] = useState([]);
  const [taskDetailAnalyzing, setTaskDetailAnalyzing] = useState(false);
  const [taskNoteInput, setTaskNoteInput] = useState("");
  const [taskNoteSubmitting, setTaskNoteSubmitting] = useState(false);
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [taskModalNote, setTaskModalNote] = useState("");
  const [taskModalSubmitting, setTaskModalSubmitting] = useState(false);
  const [taskModalAlert, setTaskModalAlert] = useState(null);
  const [taskModalIsProactive, setTaskModalIsProactive] = useState(false);
  const [taskModalIsInfo, setTaskModalIsInfo] = useState(false);
  const [taskModalSnoozeDate, setTaskModalSnoozeDate] = useState("");
  const [taskModalSnoozeTime, setTaskModalSnoozeTime] = useState("07:00");
  const [taskSnoozeDate, setTaskSnoozeDate] = useState("");
  const [taskSnoozeTime, setTaskSnoozeTime] = useState("07:00");
  const [taskSnoozeSubmitting, setTaskSnoozeSubmitting] = useState(false);
  const [taskActionError, setTaskActionError] = useState("");
  const [existingTaskBanner, setExistingTaskBanner] = useState(null);

  return {
    tasks, setTasks, tasksLoading, setTasksLoading, tasksFilter, setTasksFilter,
    selectedTask, setSelectedTask, taskDetailOptions, setTaskDetailOptions,
    taskDetailAnalyzing, setTaskDetailAnalyzing, taskNoteInput, setTaskNoteInput,
    taskNoteSubmitting, setTaskNoteSubmitting, showTaskModal, setShowTaskModal,
    taskModalNote, setTaskModalNote, taskModalSubmitting, setTaskModalSubmitting,
    taskModalAlert, setTaskModalAlert, taskModalIsProactive, setTaskModalIsProactive,
    taskModalIsInfo, setTaskModalIsInfo,
    taskModalSnoozeDate, setTaskModalSnoozeDate, taskModalSnoozeTime, setTaskModalSnoozeTime,
    taskSnoozeDate, setTaskSnoozeDate, taskSnoozeTime, setTaskSnoozeTime,
    taskSnoozeSubmitting, setTaskSnoozeSubmitting, taskActionError, setTaskActionError,
    existingTaskBanner, setExistingTaskBanner
  };
}