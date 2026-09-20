import { useState } from "react";

export function useBulkActions() {
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState(new Set());
  const [showBulkIgnoreModal, setShowBulkIgnoreModal] = useState(false);
  const [showBulkTaskModal, setShowBulkTaskModal] = useState(false);
  const [bulkIgnoreReason, setBulkIgnoreReason] = useState("");
  const [bulkTaskNote, setBulkTaskNote] = useState("");
  const [bulkTaskSnoozeDate, setBulkTaskSnoozeDate] = useState("");
  const [bulkTaskSnoozeTime, setBulkTaskSnoozeTime] = useState("07:00");
  const [bulkSubmitting, setBulkSubmitting] = useState(false);

  const [proactiveBulkMode, setProactiveBulkMode] = useState(false);
  const [proactiveBulkSelected, setProactiveBulkSelected] = useState(new Set());
  const [proactiveBulkSubmitting, setProactiveBulkSubmitting] = useState(false);
  const [showProactiveBulkTaskModal, setShowProactiveBulkTaskModal] = useState(false);
  const [proactiveBulkTaskNote, setProactiveBulkTaskNote] = useState("");
  const [proactiveBulkTaskSnoozeDate, setProactiveBulkTaskSnoozeDate] = useState("");
  const [proactiveBulkTaskSnoozeTime, setProactiveBulkTaskSnoozeTime] = useState("07:00");

  const [infoBulkMode, setInfoBulkMode] = useState(false);
  const [infoBulkSelected, setInfoBulkSelected] = useState(new Set());
  const [infoBulkSubmitting, setInfoBulkSubmitting] = useState(false);
  const [showInfoBulkTaskModal, setShowInfoBulkTaskModal] = useState(false);
  const [infoBulkTaskNote, setInfoBulkTaskNote] = useState("");
  const [infoBulkTaskSnoozeDate, setInfoBulkTaskSnoozeDate] = useState("");
  const [infoBulkTaskSnoozeTime, setInfoBulkTaskSnoozeTime] = useState("07:00");

  return {
    bulkMode, setBulkMode, bulkSelected, setBulkSelected,
    showBulkIgnoreModal, setShowBulkIgnoreModal, showBulkTaskModal, setShowBulkTaskModal,
    bulkIgnoreReason, setBulkIgnoreReason, bulkTaskNote, setBulkTaskNote,
    bulkTaskSnoozeDate, setBulkTaskSnoozeDate, bulkTaskSnoozeTime, setBulkTaskSnoozeTime,
    bulkSubmitting, setBulkSubmitting,
    proactiveBulkMode, setProactiveBulkMode, proactiveBulkSelected, setProactiveBulkSelected,
    proactiveBulkSubmitting, setProactiveBulkSubmitting, showProactiveBulkTaskModal, setShowProactiveBulkTaskModal,
    proactiveBulkTaskNote, setProactiveBulkTaskNote, proactiveBulkTaskSnoozeDate, setProactiveBulkTaskSnoozeDate,
    proactiveBulkTaskSnoozeTime, setProactiveBulkTaskSnoozeTime,
    infoBulkMode, setInfoBulkMode, infoBulkSelected, setInfoBulkSelected,
    infoBulkSubmitting, setInfoBulkSubmitting, showInfoBulkTaskModal, setShowInfoBulkTaskModal,
    infoBulkTaskNote, setInfoBulkTaskNote, infoBulkTaskSnoozeDate, setInfoBulkTaskSnoozeDate,
    infoBulkTaskSnoozeTime, setInfoBulkTaskSnoozeTime
  };
}