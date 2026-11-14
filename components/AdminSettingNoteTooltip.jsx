import React, { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * AdminSettingNoteTooltip
 * Strictly admin-only hover/click popover rendering verbatim Master Sheet
 * explainer notes via a React portal to avoid container overflow clipping.
 */
export default function AdminSettingNoteTooltip({ notes, isAdmin = false }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [coords, setCoords] = useState(null);

  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const closeTimerRef = useRef(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const computeCoords = useCallback(() => {
    if (typeof window === "undefined" || !triggerRef.current) return null;
    const rect = triggerRef.current.getBoundingClientRect();
    const tooltipWidth = Math.min(380, window.innerWidth - 24);
    const left = Math.max(
      12,
      Math.min(rect.left, window.innerWidth - tooltipWidth - 12)
    );
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const placeBelow = spaceBelow >= 240 || spaceBelow >= spaceAbove;

    if (placeBelow) {
      return {
        left,
        width: tooltipWidth,
        top: rect.bottom + 6,
        maxHeight: Math.max(120, Math.min(320, spaceBelow - 18))
      };
    }

    return {
      left,
      width: tooltipWidth,
      bottom: window.innerHeight - rect.top + 6,
      maxHeight: Math.max(120, Math.min(320, spaceAbove - 18))
    };
  }, []);

  const openPopover = useCallback(() => {
    clearCloseTimer();
    const nextCoords = computeCoords();
    if (!nextCoords) return;
    setCoords(nextCoords);
    setIsOpen(true);
  }, [clearCloseTimer, computeCoords]);

  const closeAll = useCallback(() => {
    clearCloseTimer();
    setIsPinned(false);
    setIsOpen(false);
    setCoords(null);
  }, [clearCloseTimer]);

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setIsOpen(false);
      setIsPinned(false);
      setCoords(null);
    }, 130);
  }, [clearCloseTimer]);

  useEffect(() => {
    return () => {
      clearCloseTimer();
    };
  }, [clearCloseTimer]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        closeAll();
      }
    };

    const handlePointerDownOutside = (e) => {
      if (
        triggerRef.current?.contains(e.target) ||
        popoverRef.current?.contains(e.target)
      ) {
        return;
      }
      closeAll();
    };

    const handleViewportChange = (e) => {
      if (e?.type === "scroll" && popoverRef.current?.contains(e.target)) {
        return;
      }
      if (!triggerRef.current) {
        closeAll();
        return;
      }
      const rect = triggerRef.current.getBoundingClientRect();
      const outOfView =
        rect.bottom < 0 ||
        rect.top > window.innerHeight ||
        rect.right < 0 ||
        rect.left > window.innerWidth;
      if (outOfView) {
        closeAll();
        return;
      }
      const updated = computeCoords();
      if (updated) setCoords(updated);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("pointerdown", handlePointerDownOutside);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("pointerdown", handlePointerDownOutside);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [isOpen, closeAll, computeCoords]);

  if (!isAdmin || !Array.isArray(notes) || notes.length === 0) {
    return null;
  }

  const labelText = notes.length > 1 ? "Master sheet notes" : "Master sheet note";

  const handleTogglePin = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isPinned) {
      closeAll();
    } else {
      setIsPinned(true);
      openPopover();
    }
  };

  return (
    <>
      <span
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-label={labelText}
        aria-expanded={isOpen}
        onMouseEnter={openPopover}
        onMouseLeave={() => {
          if (!isPinned) scheduleClose();
        }}
        onFocus={openPopover}
        onBlur={(e) => {
          if (!isPinned && !popoverRef.current?.contains(e.relatedTarget)) {
            scheduleClose();
          }
        }}
        onClick={handleTogglePin}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            handleTogglePin(e);
          }
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "16px",
          height: "16px",
          borderRadius: "50%",
          color: isOpen ? "#0066CC" : "#64748B",
          background: isOpen ? "#DBEAFE" : "transparent",
          cursor: "help",
          flexShrink: 0,
          verticalAlign: "middle",
          lineHeight: 1,
          transition: "all 0.15s ease",
          outline: "none"
        }}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      </span>

      {isOpen && coords && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popoverRef}
            role="tooltip"
            onMouseEnter={clearCloseTimer}
            onMouseLeave={() => {
              if (!isPinned) scheduleClose();
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              zIndex: 10050,
              left: `${coords.left}px`,
              width: `${coords.width}px`,
              ...(coords.top !== undefined ? { top: `${coords.top}px` } : {}),
              ...(coords.bottom !== undefined ? { bottom: `${coords.bottom}px` } : {}),
              maxHeight: `${coords.maxHeight}px`,
              overflowY: "auto",
              background: "#0F172A",
              color: "#F8FAFC",
              border: "1px solid #334155",
              borderRadius: "8px",
              padding: "10px 12px",
              boxShadow: "0 12px 28px -6px rgba(15, 23, 42, 0.45), 0 4px 10px -3px rgba(15, 23, 42, 0.3)",
              fontSize: "12px",
              lineHeight: "1.5",
              textAlign: "left",
              fontWeight: "400",
              textTransform: "none",
              letterSpacing: "normal",
              whiteSpace: "normal",
              boxSizing: "border-box"
            }}
          >
            <div
              style={{
                fontSize: "11px",
                fontWeight: "700",
                color: "#94A3B8",
                marginBottom: "6px"
              }}
            >
              {labelText}
            </div>

            {notes.map((item, idx) => (
              <div
                key={`${item.source}-${idx}`}
                style={
                  idx > 0
                    ? {
                        borderTop: "1px solid #1E293B",
                        paddingTop: "8px",
                        marginTop: "8px"
                      }
                    : undefined
                }
              >
                <div style={{ marginBottom: "4px" }}>
                  <span
                    style={{
                      display: "inline-block",
                      fontFamily: "monospace",
                      fontSize: "10.5px",
                      fontWeight: "600",
                      color: "#93C5FD",
                      background: "#1E293B",
                      border: "1px solid #334155",
                      borderRadius: "4px",
                      padding: "1px 6px"
                    }}
                  >
                    {item.source}
                  </span>
                </div>
                <div
                  style={{
                    color: "#F1F5F9",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word"
                  }}
                >
                  {item.text}
                </div>
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
