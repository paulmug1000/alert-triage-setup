import React from "react";

/**
 * NoteIndicatorButton
 * Prominent note indicator and trigger button for jobs, invoices, and expenses.
 * Obvious amber/yellow badge when a note exists, subtle outline when empty.
 */
export default function NoteIndicatorButton({
  note = "",
  onClick,
  title,
  size = "md", // "sm" | "md"
  style = {},
}) {
  const hasNote = Boolean(note && String(note).trim() !== "");
  const isSm = size === "sm";
  const tooltipText = title || (hasNote ? `Note: ${note}` : "Add note");

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (onClick) onClick(e);
      }}
      title={tooltipText}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: isSm ? "2px 4px" : "3px 6px",
        borderRadius: "5px",
        border: hasNote ? "1px solid #f59e0b" : "1px solid transparent",
        background: hasNote ? "#fef3c7" : "transparent",
        color: hasNote ? "#b45309" : "#94a3b8",
        cursor: "pointer",
        lineHeight: 1,
        transition: "all 0.15s ease",
        opacity: hasNote ? 1 : 0.45,
        boxShadow: hasNote ? "0 1px 2px rgba(245, 158, 11, 0.15)" : "none",
        verticalAlign: "middle",
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!hasNote) {
          e.currentTarget.style.opacity = "1";
          e.currentTarget.style.background = "#f1f5f9";
          e.currentTarget.style.borderColor = "#cbd5e1";
          e.currentTarget.style.color = "#475569";
        } else {
          e.currentTarget.style.background = "#fde68a";
          e.currentTarget.style.borderColor = "#d97706";
        }
      }}
      onMouseLeave={(e) => {
        if (!hasNote) {
          e.currentTarget.style.opacity = "0.45";
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.borderColor = "transparent";
          e.currentTarget.style.color = "#94a3b8";
        } else {
          e.currentTarget.style.background = "#fef3c7";
          e.currentTarget.style.borderColor = "#f59e0b";
        }
      }}
    >
      <svg
        width={isSm ? "12" : "14"}
        height={isSm ? "12" : "14"}
        viewBox="0 0 24 24"
        fill={hasNote ? "#fbbf24" : "none"}
        stroke={hasNote ? "#b45309" : "currentColor"}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    </button>
  );
}
