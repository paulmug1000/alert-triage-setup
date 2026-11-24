import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import PulseNotesDrawer from "../components/portal/PulseNotesDrawer";

const PulseNotesContext = createContext(null);

const HOVER_CSS_ID = "pulse-notes-hover-styles";
const HOVER_CSS = `
  .pulse-note-row .pulse-note-hover-reveal {
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.14s ease;
  }
  .pulse-note-row:hover .pulse-note-hover-reveal,
  .pulse-note-row:focus-within .pulse-note-hover-reveal {
    opacity: 1 !important;
    pointer-events: auto !important;
  }
  .pulse-note-cell .pulse-note-cell-add {
    opacity: 0;
    transition: opacity 0.14s ease;
  }
  .pulse-note-cell:hover .pulse-note-cell-add,
  .pulse-note-cell:focus-within .pulse-note-cell-add {
    opacity: 1 !important;
  }
  @media (hover: none) {
    .pulse-note-row .pulse-note-hover-reveal {
      opacity: 0.78;
      pointer-events: auto;
    }
    .pulse-note-cell .pulse-note-cell-add {
      opacity: 0.55;
    }
  }
`;

const EMPTY_SUMMARY = {
  byEntityKey: {},
  byParentKey: {},
  jobChildNotesByParent: {},
  totalCount: 0,
  openNotifyCount: 0,
  unreadReplyCount: 0,
};

export function PulseNotesProvider({
  clientName = "",
  clientSheetId = "",
  user = null,
  isReadOnly = false,
  onNavigateToView = null,
  initialNoteId = "",
  onInitialNoteHandled = null,
  children,
}) {
  const [summary, setSummary] = useState(EMPTY_SUMMARY);
  const [summaryLoaded, setSummaryLoaded] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [drawerState, setDrawerState] = useState({
    isOpen: false,
    mode: "target", // "target" | "all"
    target: null,
    initialFilter: "all",
    focusNoteId: "",
  });

  const activeClientRef = useRef("");
  const currentClientKey = `${clientName}::${clientSheetId}`;
  activeClientRef.current = currentClientKey;
  const handledInitialNoteRef = useRef("");
  const notesCacheRef = useRef(new Map());
  const notesCacheClientRef = useRef("");

  if (notesCacheClientRef.current !== currentClientKey) {
    notesCacheRef.current.clear();
    notesCacheClientRef.current = currentClientKey;
  }

  // Inject progressive-disclosure hover styles once
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (!document.getElementById(HOVER_CSS_ID)) {
      const style = document.createElement("style");
      style.id = HOVER_CSS_ID;
      style.textContent = HOVER_CSS;
      document.head.appendChild(style);
    }
  }, []);

  const prefetchAllNotes = useCallback(async (targetClientName, targetClientSheetId, reqKey) => {
    if (!targetClientName || !targetClientSheetId) return;
    try {
      const listUrl = `/api/portal/notes?mode=list&clientSheetId=${encodeURIComponent(targetClientSheetId)}&clientName=${encodeURIComponent(targetClientName)}`;
      const res = await fetch(listUrl);
      const data = await res.json();
      if (activeClientRef.current !== reqKey) return;
      if (data?.success && Array.isArray(data.notes)) {
        notesCacheRef.current.set("all::", {
          notes: data.notes,
          fetchedAt: Date.now(),
        });
      }
    } catch {
      // Non-fatal background warmup
    }
  }, []);

  const refreshSummary = useCallback(async () => {
    if (!clientSheetId || !clientName) {
      setSummary(EMPTY_SUMMARY);
      setSummaryLoaded(false);
      return;
    }
    const reqKey = `${clientName}::${clientSheetId}`;
    setLoadingSummary(true);
    try {
      const url = `/api/portal/notes?mode=summary&clientSheetId=${encodeURIComponent(clientSheetId)}&clientName=${encodeURIComponent(clientName)}`;
      const res = await fetch(url);
      const data = await res.json();
      if (activeClientRef.current !== reqKey) return;
      if (data?.success) {
        const nextTotal = Number(data.totalCount || 0);
        setSummary({
          byEntityKey: data.byEntityKey || {},
          byParentKey: data.byParentKey || {},
          jobChildNotesByParent: data.jobChildNotesByParent || {},
          totalCount: nextTotal,
          openNotifyCount: Number(data.openNotifyCount || 0),
          unreadReplyCount: Number(data.unreadReplyCount || 0),
        });
        setSummaryLoaded(true);
        if (nextTotal === 0) {
          notesCacheRef.current.set("all::", { notes: [], fetchedAt: Date.now() });
        } else if (!notesCacheRef.current.has("all::")) {
          prefetchAllNotes(clientName, clientSheetId, reqKey);
        }
      }
    } catch (err) {
      console.warn("[PulseNotes] Summary fetch warning:", err?.message);
    } finally {
      if (activeClientRef.current === reqKey) {
        setLoadingSummary(false);
      }
    }
  }, [clientName, clientSheetId, prefetchAllNotes]);

  useEffect(() => {
    setSummary(EMPTY_SUMMARY);
    setSummaryLoaded(false);
    setDrawerState((prev) => (prev.isOpen ? { ...prev, isOpen: false } : prev));
    if (clientSheetId && clientName) {
      refreshSummary();
    }
  }, [clientName, clientSheetId, refreshSummary]);

  const getCachedNotes = useCallback(
    (cacheKey) => {
      if (!cacheKey || notesCacheClientRef.current !== activeClientRef.current) return null;
      const exact = notesCacheRef.current.get(cacheKey);
      if (exact && Array.isArray(exact.notes)) {
        return exact.notes;
      }

      const allEntry = notesCacheRef.current.get("all::");
      const allNotes = Array.isArray(allEntry?.notes) ? allEntry.notes : null;
      const allComplete = allNotes !== null && Number(summary.totalCount || 0) <= 300;

      if (cacheKey.startsWith("all::")) {
        const entityType = cacheKey.slice(5);
        if (summaryLoaded && Number(summary.totalCount || 0) === 0) {
          return [];
        }
        if (allComplete) {
          return entityType ? allNotes.filter((n) => n.entityType === entityType) : allNotes;
        }
        return null;
      }

      const targetMatch = /^target::(.+)::(true|false)$/.exec(cacheKey);
      if (targetMatch) {
        const entityKey = targetMatch[1];
        const incChildren = targetMatch[2] === "true";
        if (summaryLoaded) {
          const directCount = summary.byEntityKey?.[entityKey]?.count || 0;
          const childCount = incChildren ? summary.byParentKey?.[entityKey]?.count || 0 : 0;
          if (directCount + childCount === 0) {
            return [];
          }
        }
        if (allComplete) {
          return incChildren
            ? allNotes.filter((n) => n.entityKey === entityKey || n.parentEntityKey === entityKey)
            : allNotes.filter((n) => n.entityKey === entityKey);
        }
      }

      return null;
    },
    [summary, summaryLoaded]
  );

  const setCachedNotes = useCallback((cacheKey, notesList) => {
    if (!cacheKey || !Array.isArray(notesList)) return;
    if (notesCacheClientRef.current !== activeClientRef.current) return;
    notesCacheRef.current.set(cacheKey, {
      notes: notesList,
      fetchedAt: Date.now(),
    });
  }, []);

  const invalidateNotesCache = useCallback(() => {
    notesCacheRef.current.clear();
  }, []);

  // Auto-open deep-linked noteId from email link (?noteId=...)
  useEffect(() => {
    const cleanId = String(initialNoteId || "").trim();
    if (!cleanId || !clientSheetId || !clientName) return;
    if (handledInitialNoteRef.current === `${clientName}:${cleanId}`) return;
    handledInitialNoteRef.current = `${clientName}:${cleanId}`;

    setDrawerState({
      isOpen: true,
      mode: "all",
      target: null,
      initialFilter: "all",
      focusNoteId: cleanId,
    });
    onInitialNoteHandled?.();
  }, [initialNoteId, clientName, clientSheetId, onInitialNoteHandled]);

  const openNotes = useCallback((target) => {
    if (!target) return;
    setDrawerState({
      isOpen: true,
      mode: "target",
      target,
      initialFilter: "all",
      focusNoteId: "",
    });
  }, []);

  const openAllNotes = useCallback((options = {}) => {
    setDrawerState({
      isOpen: true,
      mode: "all",
      target: null,
      initialFilter: options.initialFilter || "all",
      initialEntityType: options.entityType || "",
      focusNoteId: options.noteId || "",
    });
  }, []);

  const closeNotes = useCallback(() => {
    setDrawerState((prev) => ({ ...prev, isOpen: false }));
  }, []);

  const getEntitySummary = useCallback(
    (entityKey) => {
      if (!entityKey) return null;
      return summary.byEntityKey?.[entityKey] || null;
    },
    [summary.byEntityKey]
  );

  const getParentSummary = useCallback(
    (parentKey) => {
      if (!parentKey) return null;
      return summary.byParentKey?.[parentKey] || null;
    },
    [summary.byParentKey]
  );

  const getJobChildNotes = useCallback(
    (jobKey) => {
      if (!jobKey) return [];
      return summary.jobChildNotesByParent?.[jobKey] || [];
    },
    [summary.jobChildNotesByParent]
  );

  const value = {
    clientName,
    clientSheetId,
    user,
    isReadOnly,
    summary,
    loadingSummary,
    totalCount: summary.totalCount || 0,
    openNotifyCount: summary.openNotifyCount || 0,
    unreadReplyCount: summary.unreadReplyCount || 0,
    openNotes,
    openAllNotes,
    closeNotes,
    refreshSummary,
    getEntitySummary,
    getParentSummary,
    getJobChildNotes,
  };

  return (
    <PulseNotesContext.Provider value={value}>
      {children}
      <PulseNotesDrawer
        isOpen={drawerState.isOpen}
        mode={drawerState.mode}
        target={drawerState.target}
        initialFilter={drawerState.initialFilter}
        initialEntityType={drawerState.initialEntityType || ""}
        focusNoteId={drawerState.focusNoteId}
        clientName={clientName}
        clientSheetId={clientSheetId}
        user={user}
        isReadOnly={isReadOnly}
        getCachedNotes={getCachedNotes}
        setCachedNotes={setCachedNotes}
        invalidateNotesCache={invalidateNotesCache}
        onClose={closeNotes}
        onNotesChanged={refreshSummary}
        onNavigateToView={(viewSlug) => {
          closeNotes();
          onNavigateToView?.(viewSlug);
        }}
      />
    </PulseNotesContext.Provider>
  );
}

const NOOP_CONTEXT = {
  clientName: "",
  clientSheetId: "",
  user: null,
  isReadOnly: false,
  summary: EMPTY_SUMMARY,
  loadingSummary: false,
  totalCount: 0,
  openNotifyCount: 0,
  unreadReplyCount: 0,
  openNotes: () => {},
  openAllNotes: () => {},
  closeNotes: () => {},
  refreshSummary: () => {},
  getEntitySummary: () => null,
  getParentSummary: () => null,
  getJobChildNotes: () => [],
};

export function usePulseNotes() {
  return useContext(PulseNotesContext) || NOOP_CONTEXT;
}
