import React, { useState, useEffect, useCallback, useMemo } from "react";
import Spinner from "./Spinner";
import DeferredSearchInput from "./DeferredSearchInput";
import { ScenarioSnapshotCard } from "./portal/PulseNotesDrawer";
import { getEntityTypeDisplayLabel, getPortalViewForNote } from "../utils/pulseNotesKeys";

function formatUkDateTime(iso) {
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

function getNoteStatusBadge(note) {
  if (note.status === "resolved") {
    return { label: "Resolved", bg: "#dcfce7", color: "#166534", border: "#bbf7d0" };
  }
  if (note.status === "replied") {
    return { label: "Replied", bg: "#dbeafe", color: "#1d4ed8", border: "#bfdbfe" };
  }
  if (note.notifyManager) {
    return { label: "Open (notified)", bg: "#fef3c7", color: "#92400e", border: "#fde68a" };
  }
  return { label: "Note", bg: "#f1f5f9", color: "#475569", border: "#e2e8f0" };
}

export default function ClientNotesView({
  clients = [],
  managedClient = null,
  initialNoteId = "",
  onClearManagedClient,
  onNotesCountChange,
}) {
  const [statusFilter, setStatusFilter] = useState("open"); // "open" | "replied" | "resolved" | "all"
  const [selectedClientFilter, setSelectedClientFilter] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [notes, setNotes] = useState([]);
  const [counts, setCounts] = useState({ open: 0, replied: 0, resolved: 0, all: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [replyDrafts, setReplyDrafts] = useState({});
  const [replyBusyId, setReplyBusyId] = useState("");
  const [statusBusyId, setStatusBusyId] = useState("");
  const [activeNoteId, setActiveNoteId] = useState(initialNoteId || "");

  const effectiveClient = managedClient?.clientName || selectedClientFilter;

  useEffect(() => {
    if (initialNoteId) {
      setActiveNoteId(initialNoteId);
      setStatusFilter("all");
    }
  }, [initialNoteId]);

  const loadNotes = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams({
        mode: "list",
        status: statusFilter,
      });
      if (effectiveClient) qs.set("clientName", effectiveClient);
      if (searchTerm.trim()) qs.set("search", searchTerm.trim());

      const res = await fetch(`/api/pma/notes?${qs.toString()}`);
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "Failed to load client notes");
      }
      setNotes(Array.isArray(data.notes) ? data.notes : []);
      if (data.counts) {
        setCounts(data.counts);
        onNotesCountChange?.(Number(data.counts.open || 0));
      }
    } catch (err) {
      setError(err.message || "Unable to load client notes");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, effectiveClient, searchTerm, onNotesCountChange]);

  useEffect(() => {
    loadNotes();
  }, [loadNotes]);

  const sortedClientOptions = useMemo(() => {
    return (clients || [])
      .map((c) => c.clientName)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }, [clients]);

  const handleSendReply = async (noteId) => {
    const body = String(replyDrafts[noteId] || "").trim();
    if (!body) return;
    setReplyBusyId(noteId);
    setError("");
    try {
      const res = await fetch("/api/pma/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reply",
          noteId,
          body,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to send reply");
      setReplyDrafts((prev) => ({ ...prev, [noteId]: "" }));
      await loadNotes();
    } catch (err) {
      setError(err.message || "Failed to send reply");
    } finally {
      setReplyBusyId("");
    }
  };

  const handleToggleStatus = async (note) => {
    const action = note.status === "resolved" ? "reopen" : "resolve";
    setStatusBusyId(note.id);
    setError("");
    try {
      const res = await fetch("/api/pma/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          noteId: note.id,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Failed to update status");
      await loadNotes();
    } catch (err) {
      setError(err.message || "Failed to update status");
    } finally {
      setStatusBusyId("");
    }
  };

  return (
    <div
      className="pma-page-container"
      style={{
        width: "100%",
        maxWidth: "100%",
        margin: "0 auto",
        padding: "20px 32px 60px",
        boxSizing: "border-box",
        fontFamily: "'Kumbh Sans', system-ui, -apple-system, sans-serif",
      }}
    >
      {/* Header Card */}
      <div
        style={{
          marginBottom: "18px",
          background: "#FFFFFF",
          padding: "16px 20px",
          borderRadius: "10px",
          border: "1px solid #E2E8F0",
          boxShadow: "0 1px 3px rgba(15, 23, 42, 0.04)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <div>
          <h1 style={{ margin: "0 0 4px 0", fontSize: "20px", fontWeight: 700, color: "#0F172A" }}>
            Client notes{managedClient ? ` — ${managedClient.clientName}` : ""}
          </h1>
          <p style={{ margin: 0, fontSize: "13px", color: "#64748B" }}>
            Notes and manager notifications sent by clients in Pulse
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          {managedClient && onClearManagedClient && (
            <button
              type="button"
              onClick={onClearManagedClient}
              style={{
                padding: "6px 12px",
                fontSize: "12px",
                fontWeight: 600,
                background: "#fef2f2",
                color: "#dc2626",
                border: "1px solid #fecaca",
                borderRadius: "6px",
                cursor: "pointer",
              }}
            >
              Show all clients
            </button>
          )}
          <button
            type="button"
            onClick={loadNotes}
            disabled={loading}
            style={{
              padding: "6px 14px",
              fontSize: "12.5px",
              fontWeight: 600,
              background: "#ffffff",
              color: "#0047AB",
              border: "1px solid #cbd5e1",
              borderRadius: "6px",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            {loading && <Spinner size={13} color="#0047AB" />}
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Filters Bar */}
      <div
        style={{
          marginBottom: "16px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "12px",
        }}
      >
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          {[
            { key: "open", label: "Open", count: counts.open },
            { key: "replied", label: "Replied", count: counts.replied },
            { key: "resolved", label: "Resolved", count: counts.resolved },
            { key: "all", label: "All notes", count: counts.all },
          ].map((tab) => {
            const active = statusFilter === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => {
                  setActiveNoteId("");
                  setStatusFilter(tab.key);
                }}
                style={{
                  padding: "6px 12px",
                  borderRadius: "7px",
                  border: `1px solid ${active ? "#0047AB" : "#cbd5e1"}`,
                  background: active ? "#0047AB" : "#ffffff",
                  color: active ? "#ffffff" : "#334155",
                  fontSize: "12.5px",
                  fontWeight: active ? 700 : 600,
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  fontFamily: "inherit",
                }}
              >
                <span>{tab.label}</span>
                <span
                  style={{
                    padding: "1px 6px",
                    borderRadius: "999px",
                    fontSize: "11px",
                    background: active ? "rgba(255,255,255,0.22)" : "#f1f5f9",
                    color: active ? "#ffffff" : "#475569",
                  }}
                >
                  {tab.count ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          {!managedClient && sortedClientOptions.length > 1 && (
            <select
              value={selectedClientFilter}
              onChange={(e) => setSelectedClientFilter(e.target.value)}
              style={{
                padding: "6px 10px",
                fontSize: "12.5px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                background: "#ffffff",
                color: "#0f172a",
                fontFamily: "inherit",
              }}
            >
              <option value="">All clients</option>
              {sortedClientOptions.map((cName) => (
                <option key={cName} value={cName}>
                  {cName}
                </option>
              ))}
            </select>
          )}

          <DeferredSearchInput
            type="text"
            placeholder="Search notes, clients, items..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            debounceMs={200}
            showClearButton
            style={{
              padding: "6px 10px",
              fontSize: "12.5px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              width: "240px",
              fontFamily: "inherit",
            }}
          />
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: "14px",
            padding: "10px 14px",
            borderRadius: "8px",
            background: "#fef2f2",
            border: "1px solid #fecaca",
            color: "#991b1b",
            fontSize: "13px",
          }}
        >
          {error}
        </div>
      )}

      {/* Notes List */}
      {loading && notes.length === 0 ? (
        <div style={{ padding: "3rem", textAlign: "center", color: "#64748b" }}>
          <Spinner size={24} color="#0047AB" />
          <div style={{ marginTop: "8px", fontSize: "13px" }}>Loading client notes...</div>
        </div>
      ) : notes.length === 0 ? (
        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "10px",
            padding: "3rem 1.5rem",
            textAlign: "center",
            color: "#64748b",
            fontSize: "13.5px",
          }}
        >
          No {statusFilter === "all" ? "" : `${statusFilter} `}client notes found.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {notes.map((note) => {
            const badge = getNoteStatusBadge(note);
            const isHighlighted = Boolean(activeNoteId && note.id === activeNoteId);
            const pulseUrl = `/pulse?client=${encodeURIComponent(note.clientName)}&view=${encodeURIComponent(getPortalViewForNote(note))}&noteId=${encodeURIComponent(note.id)}`;

            return (
              <div
                key={note.id}
                style={{
                  background: "#ffffff",
                  border: `1px solid ${isHighlighted ? "#0047AB" : "#e2e8f0"}`,
                  boxShadow: isHighlighted
                    ? "0 0 0 2px rgba(0, 71, 171, 0.15)"
                    : "0 1px 3px rgba(15, 23, 42, 0.04)",
                  borderRadius: "10px",
                  padding: "16px 18px",
                }}
              >
                {/* Top Metadata Row */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                    flexWrap: "wrap",
                    gap: "10px",
                    marginBottom: "8px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <span
                      style={{
                        fontSize: "12px",
                        fontWeight: 700,
                        padding: "2px 9px",
                        borderRadius: "6px",
                        background: "#0047AB",
                        color: "#ffffff",
                      }}
                    >
                      {note.clientName}
                    </span>
                    <span
                      style={{
                        fontSize: "11.5px",
                        fontWeight: 700,
                        padding: "2px 8px",
                        borderRadius: "6px",
                        background: "#eff6ff",
                        color: "#0047AB",
                        border: "1px solid #bfdbfe",
                      }}
                    >
                      {getEntityTypeDisplayLabel(note.entityType)}
                    </span>
                    <span style={{ fontSize: "13.5px", fontWeight: 700, color: "#0f172a" }}>
                      {note.entityLabel}
                    </span>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: 700,
                        padding: "2px 9px",
                        borderRadius: "999px",
                        background: badge.bg,
                        color: badge.color,
                        border: `1px solid ${badge.border}`,
                      }}
                    >
                      {badge.label}
                    </span>
                    <a
                      href={pulseUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        fontSize: "12px",
                        fontWeight: 600,
                        color: "#0047AB",
                        textDecoration: "none",
                        padding: "3px 8px",
                        borderRadius: "6px",
                        border: "1px solid #cbd5e1",
                        background: "#f8fafc",
                      }}
                    >
                      Open in Pulse ↗
                    </a>
                  </div>
                </div>

                {/* Author + Timestamp */}
                <div style={{ fontSize: "12px", color: "#64748b", marginBottom: "8px" }}>
                  From <strong style={{ color: "#334155" }}>{note.authorName || note.authorEmail}</strong> ·{" "}
                  {formatUkDateTime(note.createdAt)}
                  {note.resolvedAt && note.status === "resolved" && (
                    <span style={{ marginLeft: "10px", color: "#15803d" }}>
                      · Resolved by {note.resolvedByName || note.resolvedByEmail} ({formatUkDateTime(note.resolvedAt)})
                    </span>
                  )}
                </div>

                {/* Note Body */}
                <div
                  style={{
                    background: "#f8fafc",
                    border: "1px solid #e2e8f0",
                    borderRadius: "8px",
                    padding: "11px 13px",
                    fontSize: "13.5px",
                    lineHeight: 1.5,
                    color: "#0f172a",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {note.body}
                </div>

                <ScenarioSnapshotCard snapshot={note.contextMeta?.scenarioSnapshot} />

                {/* Replies */}
                {Array.isArray(note.replies) && note.replies.length > 0 && (
                  <div
                    style={{
                      marginTop: "10px",
                      paddingLeft: "12px",
                      borderLeft: "2px solid #cbd5e1",
                      display: "flex",
                      flexDirection: "column",
                      gap: "7px",
                    }}
                  >
                    {note.replies.map((rep) => (
                      <div
                        key={rep.id}
                        style={{
                          background: rep.isStaffReply ? "#eff6ff" : "#f8fafc",
                          border: `1px solid ${rep.isStaffReply ? "#bfdbfe" : "#e2e8f0"}`,
                          borderRadius: "7px",
                          padding: "8px 11px",
                        }}
                      >
                        <div style={{ fontSize: "11.5px", fontWeight: 700, color: rep.isStaffReply ? "#0047AB" : "#334155", marginBottom: "2px" }}>
                          {rep.authorName || rep.authorEmail}
                          {rep.isStaffReply ? " (Client manager)" : ""}
                          <span style={{ fontWeight: 400, color: "#94a3b8", marginLeft: "6px" }}>
                            {formatUkDateTime(rep.createdAt)}
                          </span>
                        </div>
                        <div style={{ fontSize: "13px", color: "#1e293b", whiteSpace: "pre-wrap" }}>{rep.body}</div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Reply Composer & Resolve Toggle */}
                <div
                  style={{
                    marginTop: "12px",
                    display: "flex",
                    alignItems: "flex-end",
                    gap: "8px",
                    flexWrap: "wrap",
                  }}
                >
                  <textarea
                    rows={2}
                    value={replyDrafts[note.id] || ""}
                    onChange={(e) => setReplyDrafts((prev) => ({ ...prev, [note.id]: e.target.value }))}
                    placeholder="Write a reply to the client (they will be notified by email)..."
                    style={{
                      flex: "1 1 280px",
                      padding: "8px 10px",
                      fontSize: "13px",
                      borderRadius: "7px",
                      border: "1px solid #cbd5e1",
                      fontFamily: "inherit",
                      resize: "vertical",
                      boxSizing: "border-box",
                    }}
                  />
                  <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <button
                      type="button"
                      disabled={replyBusyId === note.id || !String(replyDrafts[note.id] || "").trim()}
                      onClick={() => handleSendReply(note.id)}
                      style={{
                        padding: "8px 14px",
                        fontSize: "12.5px",
                        fontWeight: 700,
                        background: "#0047AB",
                        color: "#ffffff",
                        border: "none",
                        borderRadius: "7px",
                        cursor:
                          replyBusyId === note.id || !String(replyDrafts[note.id] || "").trim()
                            ? "not-allowed"
                            : "pointer",
                        opacity:
                          replyBusyId === note.id || !String(replyDrafts[note.id] || "").trim()
                            ? 0.6
                            : 1,
                        fontFamily: "inherit",
                      }}
                    >
                      {replyBusyId === note.id ? "Sending..." : "Send reply"}
                    </button>

                    <button
                      type="button"
                      disabled={statusBusyId === note.id}
                      onClick={() => handleToggleStatus(note)}
                      style={{
                        padding: "8px 12px",
                        fontSize: "12.5px",
                        fontWeight: 600,
                        background: note.status === "resolved" ? "#f1f5f9" : "#f0fdf4",
                        color: note.status === "resolved" ? "#475569" : "#15803d",
                        border: `1px solid ${note.status === "resolved" ? "#cbd5e1" : "#86efac"}`,
                        borderRadius: "7px",
                        cursor: statusBusyId === note.id ? "wait" : "pointer",
                        opacity: statusBusyId === note.id ? 0.75 : 1,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px",
                        fontFamily: "inherit",
                      }}
                    >
                      {statusBusyId === note.id ? (
                        <>
                          <Spinner size={12} color={note.status === "resolved" ? "#475569" : "#15803d"} />
                          <span>{note.status === "resolved" ? "Reopening..." : "Resolving..."}</span>
                        </>
                      ) : (
                        <span>{note.status === "resolved" ? "Reopen" : "Mark as resolved"}</span>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
