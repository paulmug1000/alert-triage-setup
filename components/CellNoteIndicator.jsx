import React, { useState } from "react";

/**
 * CellNoteIndicator
 * Mirrors Google Sheets' subtle top-right corner triangle indicator for cells with notes.
 * Displays a clean hover tooltip with the note text and handles optional click actions.
 */
export default function CellNoteIndicator({
  note = "",
  onClick,
  title,
  color = "#0047AB",
  size = 6,
  showAddOnHover = false,
  tooltipPosition = "bottom-right",
}) {
  const [isHovered, setIsHovered] = useState(false);
  const hasNote = Boolean(note && String(note).trim());

  if (!hasNote && !showAddOnHover) {
    return null;
  }

  const tooltipText = title || note;

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={(e) => {
        if (onClick) {
          e.stopPropagation();
          onClick(e);
        }
      }}
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        width: `${size * 2}px`,
        height: `${size * 2}px`,
        cursor: onClick ? "pointer" : "default",
        zIndex: 3,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "flex-end",
      }}
      title={tooltipText ? undefined : undefined} // We provide custom styled tooltip below
    >
      {/* Corner triangle (mirrors Google Sheets) */}
      {hasNote ? (
        <span
          style={{
            width: 0,
            height: 0,
            borderTop: `${size}px solid ${color}`,
            borderLeft: `${size}px solid transparent`,
            display: "block",
            transition: "transform 0.1s ease",
            transform: isHovered && onClick ? "scale(1.2)" : "scale(1)",
          }}
        />
      ) : showAddOnHover && isHovered ? (
        <span
          style={{
            fontSize: "9px",
            lineHeight: 1,
            color: "#94a3b8",
            padding: "1px 2px",
            background: "rgba(241, 245, 249, 0.9)",
            borderRadius: "0 0 0 3px",
            fontWeight: 700,
          }}
          title="Add note"
        >
          +
        </span>
      ) : null}

      {/* Rich hover tooltip */}
      {hasNote && isHovered && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: "4px",
            background: "#1e293b",
            color: "#f8fafc",
            padding: "8px 12px",
            borderRadius: "6px",
            fontSize: "11.5px",
            lineHeight: "1.45",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            minWidth: "160px",
            maxWidth: "320px",
            boxShadow: "0 10px 25px -5px rgba(0,0,0,0.3), 0 8px 10px -6px rgba(0,0,0,0.2)",
            zIndex: 9999,
            pointerEvents: "none",
            textAlign: "left",
            border: "1px solid #334155",
          }}
        >
          <div
            style={{
              fontSize: "10px",
              fontWeight: 700,
              color: "#94a3b8",
              marginBottom: "3px",
            }}
          >
            Note
          </div>
          <div style={{ color: "#ffffff", fontWeight: 500 }}>{tooltipText}</div>
          {onClick && (
            <div
              style={{
                marginTop: "6px",
                paddingTop: "4px",
                borderTop: "1px solid #334155",
                fontSize: "10px",
                color: "#60a5fa",
                fontWeight: 600,
              }}
            >
              Click to edit note
            </div>
          )}
        </div>
      )}
    </div>
  );
}
