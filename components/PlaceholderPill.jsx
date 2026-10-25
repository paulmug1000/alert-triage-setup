import React, { useState } from "react";

/**
 * Checks whether a given invoice ref or expense appId represents an automatic placeholder.
 */
export function isAutoPlaceholder(refOrAppId) {
  const s = String(refOrAppId || "").trim().toUpperCase();
  return s.startsWith("PLACE");
}

export function generatePlaceholderInvoiceRef(dateStr) {
  const d = dateStr ? String(dateStr).replace(/[^a-zA-Z0-9]/g, "").slice(0, 6) : "Entry";
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `PLACE-INV-${d}-${rand}`;
}

export function generatePlaceholderExpenseId(dateStr) {
  const d = dateStr ? String(dateStr).replace(/[^a-zA-Z0-9]/g, "").slice(0, 6) : "Entry";
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `PLACE-EXP-${d}-${rand}`;
}

/**
 * PlaceholderPill
 *
 * Renders "Placeholder - auto" or "Placeholder - manual" with interactive Option B toggle.
 */
export default function PlaceholderPill({
  isAuto = true,
  onToggle = null,
  disabled = false,
  size = "md",
  style = {},
}) {
  const label = isAuto ? "Placeholder - auto" : "Placeholder - manual";
  const tooltip = disabled
    ? (isAuto ? "Automatic placeholder (locked)" : "Manual placeholder")
    : (isAuto
      ? "Automatic placeholder. Click to convert to manual placeholder to edit."
      : "Manual placeholder. Click to convert to automatic placeholder.");

  const bg = isAuto ? "#f5f3ff" : "#f0f9ff";
  const color = isAuto ? "#6b21a8" : "#0369a1";
  const border = isAuto ? "#ddd6fe" : "#bae6fd";

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled && onToggle) onToggle(!isAuto);
      }}
      disabled={disabled}
      title={tooltip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        background: bg,
        color: color,
        border: `1px solid ${border}`,
        borderRadius: "12px",
        padding: size === "sm" ? "1px 7px" : "3px 8px",
        fontSize: size === "sm" ? "10px" : "11px",
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        lineHeight: 1.3,
        userSelect: "none",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      <span>{label}</span>
      {!disabled && onToggle && (
        <span
          style={{ fontSize: "10px", opacity: 0.7, marginLeft: "1px" }}
          aria-hidden="true"
        >
          ⇄
        </span>
      )}
    </button>
  );
}
