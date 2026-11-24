import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Spinner from "../Spinner";
import { getEntityTypeDisplayLabel, getPortalViewForNote } from "../../utils/pulseNotesKeys";

function formatShortUkDate(iso) {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return String(iso);
  }
}

function getStatusBadge(note) {
  if (note.status === "resolved") {
    return { label: "Resolved", bg: "#dcfce7", color: "#166534", border: "#bbf7d0" };
  }
  if (note.status === "replied") {
    return { label: "Replied", bg: "#dbeafe", color: "#1d4ed8", border: "#bfdbfe" };
  }
  if (note.notifyManager) {
    return { label: "Manager notified", bg: "#fffbeb", color: "#92400e", border: "#fde68a" };
  }
  return { label: "Note", bg: "#f1f5f9", color: "#475569", border: "#e2e8f0" };
}

export function ScenarioSnapshotCard({ snapshot }) {
  const [expanded, setExpanded] = useState(false);
  if (!snapshot || typeof snapshot !== "object" || !snapshot.hasChanges) return null;

  const adjCount = Array.isArray(snapshot.adjustments) ? snapshot.adjustments.length : 0;
  const confCount = Array.isArray(snapshot.confirmedPipelineJobs) ? snapshot.confirmedPipelineJobs.length : 0;
  const exclCount = Array.isArray(snapshot.excludedPipelineJobs) ? snapshot.excludedPipelineJobs.length : 0;
  const nbCount = Array.isArray(snapshot.disabledNBMonths) ? snapshot.disabledNBMonths.length : 0;

  return (
    <div
      style={{
        marginTop: "8px",
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: "7px",
        overflow: "hidden",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: "100%",
          padding: "7px 10px",
          background: "transparent",
          border: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          cursor: "pointer",
          fontSize: "11.5px",
          fontWeight: 600,
          color: "#0047AB",
          fontFamily: "inherit",
        }}
      >
        <span>
          Scenario snapshot{snapshot.fyLabel ? ` (${snapshot.fyLabel})` : ""} ·{" "}
          {[
            confCount > 0 ? `${confCount} confirmed` : "",
            exclCount > 0 ? `${exclCount} excluded` : "",
            nbCount > 0 ? `${nbCount} NB off` : "",
            adjCount > 0 ? `${adjCount} adj.` : "",
          ]
            .filter(Boolean)
            .join(", ")}
        </span>
        <span style={{ fontSize: "10px" }}>{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div
          style={{
            padding: "8px 10px 10px",
            borderTop: "1px solid #e2e8f0",
            fontSize: "11.5px",
            color: "#334155",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
          }}
        >
          {confCount > 0 && (
            <div>
              <strong>Pipeline treated as confirmed:</strong>{" "}
              {snapshot.confirmedPipelineJobs.join(", ")}
            </div>
          )}
          {exclCount > 0 && (
            <div>
              <strong>Pipeline excluded:</strong> {snapshot.excludedPipelineJobs.join(", ")}
            </div>
          )}
          {nbCount > 0 && (
            <div>
              <strong>New business to find excluded:</strong> {snapshot.disabledNBMonths.join(", ")}
            </div>
          )}
          {adjCount > 0 && (
            <div>
              <strong>Adjustments:</strong>
              <ul style={{ margin: "4px 0 0 0", paddingLeft: "16px" }}>
                {snapshot.adjustments.map((a, i) => (
                  <li key={i}>
                    {a.category} ({a.month}): {a.currencySymbol || "£"}
                    {Number(a.amount).toLocaleString("en-GB")}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function PulseNotesDrawer({
  isOpen,
  mode = "target", // "target" | "all"
  target = null,
  initialFilter = "all",
  initialEntityType = "",
  focusNoteId = "",
  clientName = "",
  clientSheetId = "",
  user = null,
  isReadOnly = false,
  apiBase = "/api/portal/notes",
  onClose,
  onNotesChanged,
  onNavigateToView,
  getCachedNotes = null,
  setCachedNotes = null,
  invalidateNotesCache = null,
}) {
  const isStaffApi = apiBase.includes("/pma/");
  const onNotesChangedRef = useRef(onNotesChanged);
  onNotesChangedRef.current = onNotesChanged;
  const setCachedNotesRef = useRef(setCachedNotes);
  setCachedNotesRef.current = setCachedNotes;
  const invalidateNotesCacheRef = useRef(invalidateNotesCache);
  invalidateNotesCacheRef.current = invalidateNotesCache;

  const openSessionKey = isOpen
    ? JSON.stringify([
        mode,
        target?.entityKey || "",
        initialEntityType || "",
        initialFilter || "all",
        clientName,
        clientSheetId || "",
      ])
    : "";

  const [userFilter, setUserFilter] = useState({ sessionKey: "", value: initialFilter || "all" });
  const filter = userFilter.sessionKey === openSessionKey ? userFilter.value : initialFilter || "all";

  const canFetch = Boolean(isOpen && clientName && (isStaffApi || clientSheetId));
  const queryKey = canFetch
    ? JSON.stringify({
        clientName,
        clientSheetId: clientSheetId || "",
        apiBase,
        mode,
        entityKey: mode === "target" ? target?.entityKey || "" : "",
        includeChildren: Boolean(mode === "target" && target?.includeChildren && target?.entityType === "job"),
        entityType: mode === "all" ? initialEntityType || "" : target?.entityType || "",
      })
    : "";

  const cacheKey = useMemo(() => {
    if (!canFetch || isStaffApi) return "";
    if (mode === "all") return `all::${initialEntityType || ""}`;
    const inc = Boolean(target?.includeChildren && target?.entityType === "job");
    return `target::${target?.entityKey || ""}::${inc}`;
  }, [canFetch, isStaffApi, mode, initialEntityType, target?.includeChildren, target?.entityType, target?.entityKey]);

  const [loadedState, setLoadedState] = useState({ key: "", notes: [] });
  const [errorState, setErrorState] = useState({ key: "", message: "" });
  const [mutationError, setMutationError] = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const requestSeqRef = useRef(0);
  const abortRef = useRef(null);

  // Composer state
  const [draftBody, setDraftBody] = useState("");
  const [includeScenarioSnapshot, setIncludeScenarioSnapshot] = useState(true);
  const [savingMode, setSavingMode] = useState(""); // "" | "note" | "notify"
  const [toastMsg, setToastMsg] = useState("");

  // Per-note reply & edit state
  const [replyOpenMap, setReplyOpenMap] = useState({});
  const [replyDrafts, setReplyDrafts] = useState({});
  const [replySendingId, setReplySendingId] = useState("");
  const [editingNoteId, setEditingNoteId] = useState("");
  const [editDraft, setEditDraft] = useState("");
  const [busyAction, setBusyAction] = useState({ noteId: "", type: "" });

  const hasLoadedCurrentQuery = Boolean(queryKey && loadedState.key === queryKey);
  const cachedNotes =
    !hasLoadedCurrentQuery && !isStaffApi && canFetch && cacheKey && typeof getCachedNotes === "function"
      ? getCachedNotes(cacheKey)
      : null;
  const cachedSeedRef = useRef(false);
  cachedSeedRef.current = Array.isArray(cachedNotes);
  const hasDisplayData = hasLoadedCurrentQuery || Array.isArray(cachedNotes);
  const notes = useMemo(
    () => (hasLoadedCurrentQuery ? loadedState.notes : Array.isArray(cachedNotes) ? cachedNotes : []),
    [hasLoadedCurrentQuery, loadedState.notes, cachedNotes]
  );
  const fetchError = queryKey && errorState.key === queryKey ? errorState.message : "";
  const error = mutationError || fetchError;
  const showLoadingSpinner = canFetch && !hasDisplayData && !fetchError;

  useEffect(() => {
    if (!isOpen) {
      abortRef.current?.abort();
      abortRef.current = null;
      requestSeqRef.current += 1;
      setLoadedState({ key: "", notes: [] });
      setErrorState({ key: "", message: "" });
      setMutationError("");
      setIsFetching(false);
      setToastMsg("");
      setSearchTerm("");
      setDraftBody("");
      setIncludeScenarioSnapshot(true);
      setEditingNoteId("");
      setEditDraft("");
      setBusyAction({ noteId: "", type: "" });
      setReplyOpenMap({});
      setReplyDrafts({});
    }
  }, [isOpen]);

  useEffect(() => {
    if (openSessionKey) {
      setMutationError("");
      setToastMsg("");
      setDraftBody("");
      setIncludeScenarioSnapshot(true);
      setEditingNoteId("");
      setEditDraft("");
    }
  }, [openSessionKey]);

  const fetchNotes = useCallback(
    async ({ silent = false } = {}) => {
      if (!canFetch || !queryKey) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const seq = ++requestSeqRef.current;
      const reqKey = queryKey;

      if (!silent) {
        setIsFetching(true);
        setErrorState((prev) => (prev.key === reqKey ? { key: "", message: "" } : prev));
      }

      try {
        const qs = new URLSearchParams({
          clientName,
          ...(clientSheetId ? { clientSheetId } : {}),
        });
        if (isStaffApi) {
          qs.set("mode", "entity");
        } else {
          qs.set("mode", "list");
        }

        if (mode === "target" && target?.entityKey) {
          if (target.includeChildren && target.entityType === "job") {
            qs.set("parentEntityKey", target.entityKey);
            qs.set("includeChildren", "true");
          } else {
            qs.set("entityKey", target.entityKey);
          }
        } else {
          if (initialEntityType) qs.set("entityType", initialEntityType);
        }

        const res = await fetch(`${apiBase}?${qs.toString()}`, { signal: controller.signal });
        const data = await res.json();
        if (requestSeqRef.current !== seq || controller.signal.aborted) return;
        if (!data.success) {
          throw new Error(data.error || "Failed to load notes");
        }
        const loaded = Array.isArray(data.notes) ? data.notes : [];
        setLoadedState({ key: reqKey, notes: loaded });
        setErrorState({ key: "", message: "" });
        if (cacheKey) {
          setCachedNotesRef.current?.(cacheKey, loaded);
        }

        // Mark unread staff replies as read when client views them
        if (!isStaffApi && !isReadOnly) {
          const unreadIds = loaded.filter((n) => n.clientUnreadReply).map((n) => n.id);
          if (unreadIds.length > 0) {
            fetch(apiBase, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "mark_read",
                clientSheetId,
                clientName,
                noteIds: unreadIds,
              }),
            })
              .then(() => {
                invalidateNotesCacheRef.current?.();
                onNotesChangedRef.current?.();
              })
              .catch(() => {});
          }
        }
      } catch (err) {
        if (err?.name === "AbortError" || requestSeqRef.current !== seq || controller.signal.aborted) {
          return;
        }
        setErrorState({ key: reqKey, message: err.message || "Unable to load notes" });
      } finally {
        if (requestSeqRef.current === seq) {
          setIsFetching(false);
        }
      }
    },
    [
      canFetch,
      queryKey,
      cacheKey,
      clientName,
      clientSheetId,
      isStaffApi,
      apiBase,
      mode,
      target?.entityKey,
      target?.includeChildren,
      target?.entityType,
      initialEntityType,
      isReadOnly,
    ]
  );

  useEffect(() => {
    if (!canFetch) return undefined;
    fetchNotes({ silent: cachedSeedRef.current });
    return () => {
      abortRef.current?.abort();
    };
  }, [canFetch, fetchNotes]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  const showToast = (msg) => {
    setToastMsg(msg);
    setTimeout(() => {
      setToastMsg((prev) => (prev === msg ? "" : prev));
    }, 4500);
  };

  const handleCreateNote = async (notifyManager) => {
    if (isReadOnly || !draftBody.trim() || !target) return;
    setSavingMode(notifyManager ? "notify" : "note");
    setMutationError("");
    try {
      const ctxMeta = { ...(target.contextMeta || {}) };
      if (target.scenarioSnapshot && includeScenarioSnapshot && target.scenarioSnapshot.hasChanges) {
        ctxMeta.scenarioSnapshot = target.scenarioSnapshot;
      }

      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          clientSheetId,
          clientName,
          scopeType: target.scopeType || "entity",
          entityType: target.entityType,
          entityKey: target.entityKey,
          parentEntityKey: target.parentEntityKey || "",
          entityLabel: target.entityLabel || "",
          contextMeta: ctxMeta,
          body: draftBody.trim(),
          notifyManager: Boolean(notifyManager && !isStaffApi),
        }),
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to save note");
      }
      setDraftBody("");
      if (data.note) {
        setLoadedState((prev) => {
          if (prev.key !== queryKey) return prev;
          return { ...prev, notes: [data.note, ...prev.notes] };
        });
      }
      if (notifyManager && data.notifiedNames?.length > 0) {
        showToast(`Saved and notified ${data.notifiedNames.join(", ")}`);
      } else if (notifyManager) {
        showToast("Saved and notified your client manager");
      } else {
        showToast("Note saved");
      }
      invalidateNotesCacheRef.current?.();
      onNotesChangedRef.current?.();
      await fetchNotes({ silent: true });
    } catch (err) {
      setMutationError(err.message || "Failed to save note");
    } finally {
      setSavingMode("");
    }
  };

  const handleSendReply = async (noteId) => {
    const text = String(replyDrafts[noteId] || "").trim();
    if (!text || isReadOnly) return;
    setReplySendingId(noteId);
    setMutationError("");
    try {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reply",
          clientSheetId,
          clientName,
          noteId,
          body: text,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to send reply");
      setReplyDrafts((prev) => ({ ...prev, [noteId]: "" }));
      setReplyOpenMap((prev) => ({ ...prev, [noteId]: false }));
      if (data.reply) {
        setLoadedState((prev) => {
          if (prev.key !== queryKey) return prev;
          return {
            ...prev,
            notes: prev.notes.map((n) =>
              n.id === noteId
                ? {
                    ...n,
                    status: data.note?.status || n.status,
                    replies: [...(Array.isArray(n.replies) ? n.replies : []), data.reply],
                  }
                : n
            ),
          };
        });
      }
      invalidateNotesCacheRef.current?.();
      onNotesChangedRef.current?.();
      await fetchNotes({ silent: true });
    } catch (err) {
      setMutationError(err.message || "Failed to send reply");
    } finally {
      setReplySendingId("");
    }
  };

  const handleToggleResolve = async (note) => {
    if (isReadOnly) return;
    const action = note.status === "resolved" ? "reopen" : "resolve";
    setBusyAction({ noteId: note.id, type: action });
    setMutationError("");
    try {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          clientSheetId,
          clientName,
          noteId: note.id,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to update note status");
      const updatedNote = data.note || {};
      setLoadedState((prev) => {
        if (prev.key !== queryKey) return prev;
        const nextStatus = updatedNote.status || (action === "resolve" ? "resolved" : "open");
        let nextNotes = prev.notes.map((n) =>
          n.id === note.id
            ? {
                ...n,
                status: nextStatus,
                resolvedByEmail: updatedNote.resolvedByEmail ?? n.resolvedByEmail,
                resolvedByName: updatedNote.resolvedByName ?? n.resolvedByName,
                resolvedAt: updatedNote.resolvedAt ?? n.resolvedAt,
                clientUnreadReply: updatedNote.clientUnreadReply ?? n.clientUnreadReply,
              }
            : n
        );
        if (mode === "all") {
          if (filter === "resolved" && nextStatus !== "resolved") {
            nextNotes = nextNotes.filter((n) => n.id !== note.id);
          }
        }
        return { ...prev, notes: nextNotes };
      });
      showToast(action === "resolve" ? "Note marked as resolved" : "Note reopened");
      invalidateNotesCacheRef.current?.();
      onNotesChangedRef.current?.();
      await fetchNotes({ silent: true });
    } catch (err) {
      setMutationError(err.message || "Failed to update note status");
    } finally {
      setBusyAction({ noteId: "", type: "" });
    }
  };

  const handleSaveEdit = async (noteId) => {
    if (isReadOnly || !editDraft.trim()) return;
    setBusyAction({ noteId, type: "edit" });
    setMutationError("");
    try {
      const trimmed = editDraft.trim();
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "edit",
          clientSheetId,
          clientName,
          noteId,
          body: trimmed,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to edit note");
      setEditingNoteId("");
      setEditDraft("");
      setLoadedState((prev) => {
        if (prev.key !== queryKey) return prev;
        return {
          ...prev,
          notes: prev.notes.map((n) => (n.id === noteId ? { ...n, body: data.note?.body || trimmed } : n)),
        };
      });
      showToast("Note updated");
      invalidateNotesCacheRef.current?.();
      onNotesChangedRef.current?.();
      await fetchNotes({ silent: true });
    } catch (err) {
      setMutationError(err.message || "Failed to edit note");
    } finally {
      setBusyAction({ noteId: "", type: "" });
    }
  };

  const handleDeleteNote = async (noteId) => {
    if (isReadOnly) return;
    setBusyAction({ noteId, type: "delete" });
    setMutationError("");
    try {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete",
          clientSheetId,
          clientName,
          noteId,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to delete note");
      setLoadedState((prev) => {
        if (prev.key !== queryKey) return prev;
        return { ...prev, notes: prev.notes.filter((n) => n.id !== noteId) };
      });
      showToast("Note deleted");
      invalidateNotesCacheRef.current?.();
      onNotesChangedRef.current?.();
      await fetchNotes({ silent: true });
    } catch (err) {
      setMutationError(err.message || "Failed to delete note");
    } finally {
      setBusyAction({ noteId: "", type: "" });
    }
  };

  // When opened for a Job, separate direct job notes from child/unmatched item notes
  const { primaryNotes, childNotes } = useMemo(() => {
    if (mode !== "target" || !target?.includeChildren || target?.entityType !== "job") {
      return { primaryNotes: notes, childNotes: [] };
    }
    const direct = [];
    const children = [];
    for (const n of notes) {
      if (n.entityKey === target.entityKey && n.entityType === "job") {
        direct.push(n);
      } else {
        children.push(n);
      }
    }
    return { primaryNotes: direct, childNotes: children };
  }, [notes, mode, target?.includeChildren, target?.entityType, target?.entityKey]);

  const tabCounts = useMemo(() => {
    let unread = 0;
    let notified = 0;
    let resolved = 0;
    for (const n of notes) {
      if (n.clientUnreadReply) unread += 1;
      if (n.notifyManager) notified += 1;
      if (n.status === "resolved") resolved += 1;
    }
    return { all: notes.length, unread, notified, resolved };
  }, [notes]);

  const filteredAllNotes = useMemo(() => {
    let base = notes;
    if (filter === "unread") {
      base = base.filter((n) => Boolean(n.clientUnreadReply));
    } else if (filter === "notified") {
      base = base.filter((n) => Boolean(n.notifyManager));
    } else if (filter === "resolved") {
      base = base.filter((n) => n.status === "resolved");
    }
    const q = searchTerm.trim().toLowerCase();
    if (!q) return base;
    return base.filter((n) => {
      const hay = `${n.entityLabel || ""} ${n.entityType || ""} ${n.body || ""} ${n.authorName || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [notes, filter, searchTerm]);

  if (!isOpen) return null;

  const userEmail = String(user?.email || "").trim().toLowerCase();
  const isStaffSession = Boolean(!user?.isReadOnly && (user?.isAdmin || user?.role === "Admin" || user?.role === "ClientManager"));

  const renderNoteCard = (note) => {
    const badge = getStatusBadge(note);
    const isFocused = Boolean(focusNoteId && note.id === focusNoteId);
    const canModify =
      !isReadOnly &&
      (isStaffSession || (userEmail && String(note.authorEmail || "").toLowerCase() === userEmail));
    const isEditingThis = editingNoteId === note.id;
    const isReplyOpen = Boolean(replyOpenMap[note.id] || isFocused);
    const isNoteBusy = busyAction.noteId === note.id;
    const isTogglingResolve = isNoteBusy && (busyAction.type === "resolve" || busyAction.type === "reopen");
    const isDeleting = isNoteBusy && busyAction.type === "delete";
    const isSavingEdit = isNoteBusy && busyAction.type === "edit";
    const resolveColor = note.status === "resolved" ? "#64748b" : "#16a34a";

    return (
      <div
        key={note.id}
        style={{
          background: isFocused ? "#eff6ff" : "#ffffff",
          border: `1px solid ${isFocused ? "#93c5fd" : "#e2e8f0"}`,
          borderRadius: "10px",
          padding: "12px 14px",
          boxShadow: "0 1px 2px rgba(15, 23, 42, 0.03)",
          opacity: isDeleting ? 0.55 : 1,
          transition: "opacity 0.15s ease",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "8px", marginBottom: "6px" }}>
          <div style={{ minWidth: 0 }}>
            {mode === "all" && (
              <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", marginBottom: "4px" }}>
                <span
                  style={{
                    fontSize: "10.5px",
                    fontWeight: 700,
                    padding: "1px 6px",
                    borderRadius: "4px",
                    background: "#eef2ff",
                    color: "#0047AB",
                  }}
                >
                  {getEntityTypeDisplayLabel(note.entityType)}
                </span>
                <span style={{ fontSize: "12px", fontWeight: 700, color: "#0f172a" }}>
                  {note.entityLabel}
                </span>
              </div>
            )}
            <div style={{ fontSize: "12px", color: "#475569", fontWeight: 600 }}>
              {note.authorName || note.authorEmail || "User"}
              <span style={{ fontWeight: 400, color: "#94a3b8", marginLeft: "6px", fontSize: "11px" }}>
                {formatShortUkDate(note.createdAt)}
              </span>
            </div>
          </div>

          <span
            style={{
              fontSize: "10.5px",
              fontWeight: 700,
              padding: "2px 8px",
              borderRadius: "999px",
              background: badge.bg,
              color: badge.color,
              border: `1px solid ${badge.border}`,
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {badge.label}
          </span>
        </div>

        {isEditingThis ? (
          <div style={{ marginTop: "6px" }}>
            <textarea
              className="pulse-notes-input"
              rows={3}
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "8px 10px",
                fontSize: "13px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                fontFamily: "inherit",
                resize: "vertical",
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "6px", marginTop: "6px" }}>
              <button
                type="button"
                onClick={() => {
                  setEditingNoteId("");
                  setEditDraft("");
                }}
                style={secondaryBtnStyle}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSavingEdit || !editDraft.trim()}
                onClick={() => handleSaveEdit(note.id)}
                style={primaryBtnStyle}
              >
                {isSavingEdit ? "Saving..." : "Save changes"}
              </button>
            </div>
          </div>
        ) : (
          <div
            style={{
              fontSize: "13px",
              lineHeight: 1.5,
              color: "#1e293b",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {note.body}
          </div>
        )}

        <ScenarioSnapshotCard snapshot={note.contextMeta?.scenarioSnapshot} />

        {/* Threaded replies */}
        {Array.isArray(note.replies) && note.replies.length > 0 && (
          <div
            style={{
              marginTop: "10px",
              paddingLeft: "10px",
              borderLeft: "2px solid #cbd5e1",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            {note.replies.map((rep) => (
              <div
                key={rep.id}
                style={{
                  background: rep.isStaffReply ? "#eff6ff" : "#f8fafc",
                  border: `1px solid ${rep.isStaffReply ? "#bfdbfe" : "#e2e8f0"}`,
                  borderRadius: "7px",
                  padding: "7px 10px",
                }}
              >
                <div style={{ fontSize: "11px", fontWeight: 700, color: rep.isStaffReply ? "#0047AB" : "#334155", marginBottom: "2px" }}>
                  {rep.authorName || rep.authorEmail}
                  {rep.isStaffReply && (
                    <span style={{ marginLeft: "6px", fontWeight: 600, fontSize: "10px", color: "#1d4ed8" }}>
                      Client manager
                    </span>
                  )}
                  <span style={{ fontWeight: 400, color: "#94a3b8", marginLeft: "6px" }}>
                    {formatShortUkDate(rep.createdAt)}
                  </span>
                </div>
                <div style={{ fontSize: "12.5px", color: "#1e293b", whiteSpace: "pre-wrap", lineHeight: 1.45 }}>
                  {rep.body}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Action links */}
        <div
          style={{
            marginTop: "8px",
            paddingTop: "6px",
            borderTop: "1px solid #f1f5f9",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "8px",
            fontSize: "11.5px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            {!isReadOnly && (note.notifyManager || isStaffSession || (note.replies && note.replies.length > 0)) && (
              <button
                type="button"
                onClick={() => setReplyOpenMap((prev) => ({ ...prev, [note.id]: !prev[note.id] }))}
                style={linkActionStyle("#0047AB")}
              >
                {isReplyOpen ? "Hide reply" : "Reply"}
              </button>
            )}
            {!isReadOnly && note.notifyManager && (
              <button
                type="button"
                disabled={isNoteBusy}
                onClick={() => handleToggleResolve(note)}
                style={{
                  ...linkActionStyle(resolveColor),
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  cursor: isNoteBusy ? "wait" : "pointer",
                  opacity: isNoteBusy ? 0.7 : 1,
                }}
              >
                {isTogglingResolve ? (
                  <>
                    <Spinner size={11} color={resolveColor} />
                    <span>{busyAction.type === "resolve" ? "Resolving..." : "Reopening..."}</span>
                  </>
                ) : (
                  <span>{note.status === "resolved" ? "Reopen" : "Mark as resolved"}</span>
                )}
              </button>
            )}
            {mode === "all" && onNavigateToView && (
              <button
                type="button"
                onClick={() => onNavigateToView(getPortalViewForNote(note))}
                style={linkActionStyle("#475569")}
              >
                Go to screen →
              </button>
            )}
          </div>

          {canModify && !isEditingThis && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <button
                type="button"
                disabled={isNoteBusy}
                onClick={() => {
                  setEditingNoteId(note.id);
                  setEditDraft(note.body);
                }}
                style={{
                  ...linkActionStyle("#64748b"),
                  cursor: isNoteBusy ? "not-allowed" : "pointer",
                  opacity: isNoteBusy ? 0.6 : 1,
                }}
              >
                Edit
              </button>
              <button
                type="button"
                disabled={isNoteBusy}
                onClick={() => handleDeleteNote(note.id)}
                style={{
                  ...linkActionStyle("#dc2626"),
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "5px",
                  cursor: isNoteBusy ? "wait" : "pointer",
                  opacity: isNoteBusy ? 0.7 : 1,
                }}
              >
                {isDeleting ? (
                  <>
                    <Spinner size={11} color="#dc2626" />
                    <span>Deleting...</span>
                  </>
                ) : (
                  <span>Delete</span>
                )}
              </button>
            </div>
          )}
        </div>

        {/* Inline reply input */}
        {isReplyOpen && !isReadOnly && (
          <div style={{ marginTop: "8px", display: "flex", gap: "6px", alignItems: "flex-end" }}>
            <textarea
              className="pulse-notes-input"
              rows={2}
              value={replyDrafts[note.id] || ""}
              onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [note.id]: e.target.value }))}
              placeholder="Write a reply..."
              style={{
                flex: 1,
                padding: "7px 9px",
                fontSize: "12.5px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                fontFamily: "inherit",
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />
            <button
              type="button"
              disabled={replySendingId === note.id || !String(replyDrafts[note.id] || "").trim()}
              onClick={() => handleSendReply(note.id)}
              style={primaryBtnStyle}
            >
              {replySendingId === note.id ? "Sending..." : "Send"}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className="pulse-notes-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.38)",
        backdropFilter: "blur(2px)",
        zIndex: 10050,
        display: "flex",
        justifyContent: "flex-end",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={mode === "all" ? "All notes" : target?.entityLabel || "Notes"}
        className="pulse-notes-panel"
        style={{
          width: "100%",
          maxWidth: "460px",
          height: "100%",
          background: "#f8fafc",
          boxShadow: "-10px 0 30px rgba(15, 23, 42, 0.18)",
          display: "flex",
          flexDirection: "column",
          fontFamily: "'Kumbh Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <div
          className="pulse-notes-drag-handle"
          aria-hidden="true"
          style={{
            width: "36px",
            height: "4px",
            borderRadius: "999px",
            background: "#cbd5e1",
            margin: "8px auto 2px",
            flexShrink: 0,
          }}
        />

        {/* Header */}
        <div
          className="pulse-notes-header"
          style={{
            padding: "16px 20px",
            background: "#ffffff",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "12px",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "15.5px", fontWeight: 700, color: "#0f172a" }}>
                {mode === "all" ? "Notes" : target?.drawerTitle || "Notes"}
              </span>
              {mode === "target" && target?.entityType && (
                <span
                  style={{
                    fontSize: "10.5px",
                    fontWeight: 700,
                    padding: "2px 7px",
                    borderRadius: "999px",
                    background: "#eff6ff",
                    color: "#0047AB",
                  }}
                >
                  {getEntityTypeDisplayLabel(target.entityType)}
                </span>
              )}
            </div>
            <div style={{ fontSize: "12.5px", color: "#64748b", marginTop: "3px", wordBreak: "break-word" }}>
              {mode === "all"
                ? `All notes and replies for ${clientName}`
                : target?.entityLabel || clientName}
            </div>
          </div>

          <button
            type="button"
            className="pulse-notes-close-btn"
            onClick={onClose}
            aria-label="Close notes"
            style={{
              background: "none",
              border: "none",
              fontSize: "18px",
              color: "#94a3b8",
              cursor: "pointer",
              padding: "2px 6px",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* All-notes filter bar */}
        {mode === "all" && (
          <div
            className="pulse-notes-filter-bar"
            style={{
              padding: "10px 20px",
              background: "#ffffff",
              borderBottom: "1px solid #e2e8f0",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            <div className="pulse-notes-filter-tabs" style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              {[
                { key: "all", label: "All", count: tabCounts.all },
                { key: "unread", label: "Unread replies", count: tabCounts.unread },
                { key: "notified", label: "Notified", count: tabCounts.notified },
                { key: "resolved", label: "Resolved", count: tabCounts.resolved },
              ].map((tab) => {
                const active = filter === tab.key;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setUserFilter({ sessionKey: openSessionKey, value: tab.key })}
                    style={{
                      padding: "4px 10px",
                      fontSize: "12px",
                      fontWeight: active ? 700 : 500,
                      borderRadius: "999px",
                      border: `1px solid ${active ? "#0047AB" : "#cbd5e1"}`,
                      background: active ? "#0047AB" : "#ffffff",
                      color: active ? "#ffffff" : "#475569",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "5px",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span>{tab.label}</span>
                    {hasDisplayData && tab.count > 0 && (
                      <span
                        style={{
                          fontSize: "10.5px",
                          fontWeight: 700,
                          padding: "0 5px",
                          borderRadius: "999px",
                          background: active ? "rgba(255,255,255,0.22)" : "#f1f5f9",
                          color: active ? "#ffffff" : "#475569",
                        }}
                      >
                        {tab.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <input
              type="text"
              className="pulse-notes-input"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search notes..."
              style={{
                width: "100%",
                padding: "6px 10px",
                fontSize: "12.5px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                boxSizing: "border-box",
                fontFamily: "inherit",
              }}
            />
          </div>
        )}

        {/* Body */}
        <div
          className="pulse-notes-body"
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px 20px",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          {error && (
            <div
              style={{
                padding: "9px 12px",
                background: "#fef2f2",
                border: "1px solid #fecaca",
                borderRadius: "7px",
                color: "#991b1b",
                fontSize: "12.5px",
              }}
            >
              {error}
            </div>
          )}

          {toastMsg && (
            <div
              style={{
                padding: "9px 12px",
                background: "#f0fdf4",
                border: "1px solid #bbf7d0",
                borderRadius: "7px",
                color: "#166534",
                fontSize: "12.5px",
                fontWeight: 600,
              }}
            >
              {toastMsg}
            </div>
          )}

          {showLoadingSpinner || (isFetching && !hasLoadedCurrentQuery) ? (
            <div
              style={{
                padding: "2.5rem 1rem",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                color: "#64748b",
                fontSize: "13px",
              }}
            >
              <Spinner size={22} color="#0047AB" />
              <div>Loading notes...</div>
            </div>
          ) : fetchError && notes.length === 0 ? null : mode === "all" ? (
            filteredAllNotes.length === 0 ? (
              <div style={{ padding: "2.5rem 1rem", textAlign: "center", color: "#64748b", fontSize: "13px" }}>
                No notes match this filter yet.
              </div>
            ) : (
              filteredAllNotes.map(renderNoteCard)
            )
          ) : primaryNotes.length === 0 && childNotes.length === 0 ? (
            <div style={{ padding: "2rem 1rem", textAlign: "center", color: "#64748b", fontSize: "13px" }}>
              No notes yet. Add a note below for future reference, or save and notify your client manager.
            </div>
          ) : (
            <>
              {primaryNotes.map(renderNoteCard)}
              {childNotes.length > 0 && (
                <div style={{ marginTop: primaryNotes.length > 0 ? "10px" : 0 }}>
                  <div
                    style={{
                      fontSize: "11.5px",
                      fontWeight: 700,
                      color: "#64748b",
                      textTransform: "uppercase",
                      letterSpacing: "0.4px",
                      marginBottom: "8px",
                    }}
                  >
                    Invoice &amp; expense notes on this job
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {childNotes.map((cn) => (
                      <div key={cn.id}>
                        <div style={{ fontSize: "11px", fontWeight: 600, color: "#0047AB", marginBottom: "3px" }}>
                          {cn.entityLabel}
                        </div>
                        {renderNoteCard(cn)}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Bottom Composer (Target mode) */}
        {mode === "target" && target && !isReadOnly && (
          <div
            className="pulse-notes-composer"
            style={{
              padding: "14px 20px",
              background: "#ffffff",
              borderTop: "1px solid #e2e8f0",
              display: "flex",
              flexDirection: "column",
              gap: "8px",
            }}
          >
            <textarea
              className="pulse-notes-input"
              rows={3}
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              placeholder="Write a note..."
              disabled={Boolean(savingMode)}
              style={{
                width: "100%",
                padding: "9px 11px",
                fontSize: "13px",
                lineHeight: 1.45,
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                outline: "none",
                boxSizing: "border-box",
                fontFamily: "inherit",
                resize: "vertical",
              }}
            />

            {target.scenarioSnapshot?.hasChanges && (
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  fontSize: "12px",
                  color: "#475569",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={includeScenarioSnapshot}
                  onChange={(e) => setIncludeScenarioSnapshot(e.target.checked)}
                  style={{ accentColor: "#0047AB" }}
                />
                <span>Include current scenario adjustments</span>
              </label>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", flexWrap: "wrap" }}>
              <button
                type="button"
                disabled={Boolean(savingMode) || !draftBody.trim()}
                onClick={() => handleCreateNote(false)}
                style={{
                  padding: "7px 14px",
                  fontSize: "12.5px",
                  fontWeight: 600,
                  color: "#1e293b",
                  background: "#f1f5f9",
                  border: "1px solid #cbd5e1",
                  borderRadius: "7px",
                  cursor: Boolean(savingMode) || !draftBody.trim() ? "not-allowed" : "pointer",
                  opacity: Boolean(savingMode) || !draftBody.trim() ? 0.6 : 1,
                  fontFamily: "inherit",
                }}
              >
                {savingMode === "note" ? "Saving..." : "Save note"}
              </button>

              {!isStaffApi && (
                <button
                  type="button"
                  disabled={Boolean(savingMode) || !draftBody.trim()}
                  onClick={() => handleCreateNote(true)}
                  style={{
                    padding: "7px 14px",
                    fontSize: "12.5px",
                    fontWeight: 700,
                    color: "#ffffff",
                    background: "#0047AB",
                    border: "none",
                    borderRadius: "7px",
                    cursor: Boolean(savingMode) || !draftBody.trim() ? "not-allowed" : "pointer",
                    opacity: Boolean(savingMode) || !draftBody.trim() ? 0.6 : 1,
                    fontFamily: "inherit",
                  }}
                >
                  {savingMode === "notify" ? "Notifying..." : "Save & notify manager"}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        .pulse-notes-drag-handle {
          display: none;
        }
        @media (max-width: 640px) {
          .pulse-notes-backdrop {
            align-items: flex-end !important;
            justify-content: center !important;
          }
          .pulse-notes-panel {
            width: 100% !important;
            max-width: 100% !important;
            height: 92dvh !important;
            max-height: 92dvh !important;
            border-radius: 16px 16px 0 0 !important;
            box-shadow: 0 -10px 30px rgba(15, 23, 42, 0.22) !important;
          }
          .pulse-notes-drag-handle {
            display: block !important;
          }
          .pulse-notes-header {
            padding: 10px 16px 12px !important;
          }
          .pulse-notes-close-btn {
            min-width: 36px;
            min-height: 36px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
          }
          .pulse-notes-filter-bar {
            padding: 10px 16px !important;
          }
          .pulse-notes-filter-tabs {
            flex-wrap: nowrap !important;
            overflow-x: auto !important;
            -webkit-overflow-scrolling: touch;
            scrollbar-width: none;
            padding-bottom: 2px;
          }
          .pulse-notes-filter-tabs::-webkit-scrollbar {
            display: none;
          }
          .pulse-notes-filter-tabs > button {
            flex-shrink: 0;
          }
          .pulse-notes-body {
            padding: 12px 16px max(16px, env(safe-area-inset-bottom)) !important;
          }
          .pulse-notes-composer {
            padding: 12px 16px max(14px, env(safe-area-inset-bottom)) !important;
          }
          .pulse-notes-input {
            font-size: 16px !important;
          }
        }
        @media (max-height: 520px) {
          .pulse-notes-panel {
            height: 100dvh !important;
            max-height: 100dvh !important;
            border-radius: 0 !important;
          }
          .pulse-notes-drag-handle {
            display: none !important;
          }
        }
      `}</style>
    </div>
  );
}

const primaryBtnStyle = {
  padding: "6px 12px",
  fontSize: "12px",
  fontWeight: 700,
  color: "#ffffff",
  background: "#0047AB",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
  fontFamily: "inherit",
};

const secondaryBtnStyle = {
  padding: "6px 12px",
  fontSize: "12px",
  fontWeight: 600,
  color: "#475569",
  background: "#ffffff",
  border: "1px solid #cbd5e1",
  borderRadius: "6px",
  cursor: "pointer",
  fontFamily: "inherit",
};

const linkActionStyle = (color) => ({
  background: "none",
  border: "none",
  padding: 0,
  color,
  fontWeight: 600,
  fontSize: "11.5px",
  cursor: "pointer",
  fontFamily: "inherit",
});
