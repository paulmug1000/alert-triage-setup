import React, { useState, useEffect } from "react";
import Spinner from "./Spinner";

/**
 * CellNoteModal
 * Modal popover for creating, reading, and editing Google Sheet cell notes directly.
 */
export default function CellNoteModal({
  isOpen,
  title = "Cell note",
  subtitle = "",
  initialNote = "",
  onSave,
  onDelete,
  onClose,
}) {
  const [noteValue, setNoteValue] = useState(initialNote || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (isOpen) {
      setNoteValue(initialNote || "");
      setError(null);
      setSaving(false);
    }
  }, [isOpen, initialNote]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(noteValue.trim());
      onClose();
    } catch (err) {
      setError(err.message || "Failed to save note");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setSaving(true);
    setError(null);
    try {
      if (onDelete) {
        await onDelete();
      } else {
        await onSave("");
      }
      onClose();
    } catch (err) {
      setError(err.message || "Failed to remove note");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.45)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "12px",
          width: "90%",
          maxWidth: "460px",
          boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.15), 0 10px 10px -5px rgba(0, 0, 0, 0.08)",
          border: "1px solid #cbd5e1",
          overflow: "hidden",
          animation: "fadeIn 0.15s ease-out",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "14px 18px",
            borderBottom: "1px solid #e2e8f0",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#f8fafc",
          }}
        >
          <div>
            <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>{title}</div>
            {subtitle && <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>{subtitle}</div>}
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              fontSize: "18px",
              color: "#94a3b8",
              cursor: "pointer",
              padding: "4px",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "18px" }}>
          {error && (
            <div
              style={{
                marginBottom: "12px",
                padding: "8px 12px",
                borderRadius: "6px",
                background: "#fef2f2",
                border: "1px solid #fecaca",
                color: "#991b1b",
                fontSize: "12px",
              }}
            >
              {error}
            </div>
          )}

          <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#334155", marginBottom: "6px" }}>
            Note content
          </label>
          <textarea
            autoFocus
            rows={5}
            value={noteValue}
            onChange={(e) => setNoteValue(e.target.value)}
            placeholder="Type your note here (mirrored in Google Sheet cell note)..."
            disabled={saving}
            style={{
              width: "100%",
              padding: "10px 12px",
              fontSize: "13px",
              lineHeight: "1.5",
              borderRadius: "8px",
              border: "1px solid #cbd5e1",
              outline: "none",
              boxSizing: "border-box",
              fontFamily: "inherit",
              resize: "vertical",
            }}
          />
          <div style={{ fontSize: "11px", color: "#64748b", marginTop: "6px" }}>
            This note is synced directly to the corresponding cell in Google Sheets.
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "12px 18px",
            borderTop: "1px solid #e2e8f0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            background: "#f8fafc",
          }}
        >
          <div>
            {initialNote && (
              <button
                type="button"
                disabled={saving}
                onClick={handleDelete}
                style={{
                  padding: "6px 12px",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: "#dc2626",
                  background: "#fee2e2",
                  border: "1px solid #fca5a5",
                  borderRadius: "6px",
                  cursor: saving ? "not-allowed" : "pointer",
                }}
              >
                Delete note
              </button>
            )}
          </div>

          <div style={{ display: "flex", gap: "8px" }}>
            <button
              type="button"
              disabled={saving}
              onClick={onClose}
              style={{
                padding: "7px 14px",
                fontSize: "12px",
                fontWeight: 600,
                color: "#475569",
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                borderRadius: "6px",
                cursor: saving ? "not-allowed" : "pointer",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={handleSave}
              style={{
                padding: "7px 16px",
                fontSize: "12px",
                fontWeight: 700,
                color: "#ffffff",
                background: "#0047AB",
                border: "none",
                borderRadius: "6px",
                cursor: saving ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              {saving && <Spinner size={12} color="#ffffff" />}
              <span>Save note</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
