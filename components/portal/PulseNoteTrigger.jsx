import React from "react";

/**
 * PulseNoteTrigger
 * Reusable, progressive-disclosure note trigger across Pulse Portal.
 *
 * Variants:
 * - "toolbar": Icon-only button matching the page toolbar Refresh and Download buttons (#0047AB),
 *              with a compact corner count badge when notes exist.
 * - "pill": Visible pill button ("Job notes") with optional count & alert dot for modal headers.
 * - "row": Hidden at rest when empty (reveals on row hover via .pulse-note-hover-reveal);
 *          compact badge when notes exist.
 * - "cell": Corner triangle inside a `position: relative` <td> when notes exist,
 *           or subtle `+` on cell hover when empty.
 * - "inline": Compact icon/pill button for modals & popovers.
 */
export default function PulseNoteTrigger({
  variant = "inline",
  count = 0,
  openNotifyCount = 0,
  unreadReplyCount = 0,
  latestSnippet = "",
  label = "Notes",
  title = "",
  onClick,
  style = {},
}) {
  const numCount = Number(count || 0);
  const hasNotes = numCount > 0;
  const hasUnread = Number(unreadReplyCount || 0) > 0;
  const hasOpen = Number(openNotifyCount || 0) > 0;

  const resolvedTitle =
    title ||
    (hasNotes
      ? `${numCount} note${numCount === 1 ? "" : "s"}${latestSnippet ? ` — ${latestSnippet}` : ""}`
      : variant === "toolbar"
        ? "Notes"
        : "Add note");

  const handleClick = (e) => {
    e.stopPropagation();
    if (onClick) onClick(e);
  };

  if (variant === "cell") {
    const triColor = hasUnread ? "#dc2626" : hasOpen ? "#0047AB" : "#d97706";
    return (
      <button
        type="button"
        onClick={handleClick}
        title={resolvedTitle}
        aria-label={resolvedTitle}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          width: "16px",
          height: "16px",
          padding: 0,
          margin: 0,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          zIndex: 3,
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "flex-end",
          ...style,
        }}
      >
        {hasNotes ? (
          <span
            style={{
              width: 0,
              height: 0,
              borderTop: `7px solid ${triColor}`,
              borderLeft: "7px solid transparent",
              display: "block",
            }}
          />
        ) : (
          <span
            className="pulse-note-cell-add"
            style={{
              fontSize: "10px",
              lineHeight: 1,
              fontWeight: 700,
              color: "#64748b",
              background: "rgba(241, 245, 249, 0.94)",
              padding: "1px 3px",
              borderRadius: "0 0 0 4px",
              borderLeft: "1px solid #cbd5e1",
              borderBottom: "1px solid #cbd5e1",
            }}
          >
            +
          </span>
        )}
      </button>
    );
  }

  if (variant === "toolbar") {
    return (
      <button
        type="button"
        onClick={handleClick}
        title={resolvedTitle}
        aria-label={resolvedTitle}
        style={{
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: "6px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#0047AB",
          borderRadius: "50%",
          position: "relative",
          ...style,
        }}
      >
        <NoteIcon size={20} strokeWidth={2.2} filled={false} color="currentColor" />
        {hasNotes && (
          <span
            style={{
              position: "absolute",
              top: "-1px",
              right: "-2px",
              minWidth: "15px",
              height: "15px",
              padding: "0 3px",
              borderRadius: "999px",
              fontSize: "9.5px",
              fontWeight: 700,
              lineHeight: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: hasUnread ? "#dc2626" : hasOpen ? "#0047AB" : "#d97706",
              color: "#ffffff",
              border: "1.5px solid #ffffff",
              pointerEvents: "none",
            }}
          >
            {numCount > 99 ? "99+" : numCount}
          </span>
        )}
      </button>
    );
  }

  if (variant === "pill") {
    const borderCol = hasUnread ? "#fca5a5" : hasOpen ? "#93c5fd" : hasNotes ? "#fcd34d" : "#cbd5e1";
    const bgCol = hasUnread ? "#fef2f2" : hasOpen ? "#eff6ff" : hasNotes ? "#fffbeb" : "#ffffff";
    const textCol = hasUnread ? "#b91c1c" : hasOpen ? "#0047AB" : hasNotes ? "#b45309" : "#334155";

    return (
      <button
        type="button"
        onClick={handleClick}
        title={resolvedTitle}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "5px 11px",
          borderRadius: "6px",
          border: `1px solid ${borderCol}`,
          background: bgCol,
          color: textCol,
          fontSize: "12.5px",
          fontWeight: 600,
          cursor: "pointer",
          lineHeight: 1.2,
          whiteSpace: "nowrap",
          transition: "all 0.15s ease",
          fontFamily: "inherit",
          ...style,
        }}
      >
        <NoteIcon size={14} filled={hasNotes} color={textCol} />
        <span>{label}</span>
        {hasNotes && (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: "17px",
              height: "17px",
              padding: "0 5px",
              borderRadius: "999px",
              fontSize: "10.5px",
              fontWeight: 700,
              background: hasUnread ? "#dc2626" : hasOpen ? "#0047AB" : "#d97706",
              color: "#ffffff",
            }}
          >
            {numCount > 99 ? "99+" : numCount}
          </span>
        )}
      </button>
    );
  }

  if (variant === "row") {
    const borderCol = hasUnread ? "#fca5a5" : hasOpen ? "#93c5fd" : hasNotes ? "#f59e0b" : "#cbd5e1";
    const bgCol = hasUnread ? "#fef2f2" : hasOpen ? "#eff6ff" : hasNotes ? "#fef3c7" : "#f8fafc";
    const textCol = hasUnread ? "#b91c1c" : hasOpen ? "#0047AB" : hasNotes ? "#b45309" : "#64748b";

    return (
      <button
        type="button"
        className={hasNotes ? "" : "pulse-note-hover-reveal"}
        onClick={handleClick}
        title={resolvedTitle}
        aria-label={resolvedTitle}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "3px",
          padding: hasNotes ? "1.5px 5px" : "2px 4px",
          borderRadius: "5px",
          border: `1px solid ${borderCol}`,
          background: bgCol,
          color: textCol,
          fontSize: "10.5px",
          fontWeight: 700,
          cursor: "pointer",
          lineHeight: 1,
          flexShrink: 0,
          position: "relative",
          ...style,
        }}
      >
        <NoteIcon size={11.5} filled={hasNotes} color={textCol} />
        {hasNotes && <span>{numCount}</span>}
        {hasUnread && (
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: "#dc2626",
              display: "inline-block",
              marginLeft: "1px",
            }}
          />
        )}
      </button>
    );
  }

  // "inline" variant (always visible compact button inside modals/popovers)
  const borderCol = hasUnread ? "#fca5a5" : hasOpen ? "#93c5fd" : hasNotes ? "#f59e0b" : "#e2e8f0";
  const bgCol = hasUnread ? "#fef2f2" : hasOpen ? "#eff6ff" : hasNotes ? "#fef3c7" : "#ffffff";
  const textCol = hasUnread ? "#b91c1c" : hasOpen ? "#0047AB" : hasNotes ? "#b45309" : "#64748b";

  return (
    <button
      type="button"
      onClick={handleClick}
      title={resolvedTitle}
      aria-label={resolvedTitle}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: hasNotes ? "3px 7px" : "3px 6px",
        borderRadius: "6px",
        border: `1px solid ${borderCol}`,
        background: bgCol,
        color: textCol,
        fontSize: "11.5px",
        fontWeight: 600,
        cursor: "pointer",
        lineHeight: 1.1,
        flexShrink: 0,
        fontFamily: "inherit",
        ...style,
      }}
    >
      <NoteIcon size={13} filled={hasNotes} color={textCol} />
      {hasNotes ? (
        <span>{numCount}</span>
      ) : label ? (
        <span>{label}</span>
      ) : null}
      {hasUnread && (
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: "#dc2626",
            display: "inline-block",
          }}
        />
      )}
    </button>
  );
}

function NoteIcon({ size = 14, filled = false, color = "currentColor", strokeWidth = 2 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "rgba(251, 191, 36, 0.25)" : "none"}
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flexShrink: 0 }}
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
