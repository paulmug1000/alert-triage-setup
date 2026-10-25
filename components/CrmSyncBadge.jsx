import React from "react";

/**
 * CrmSyncBadge
 *
 * Visual indicator badge representing that a job/deal originates from and is actively synced
 * with an external CRM (Option 4: Data Exchange opposing directional arrows).
 * Sits beside the "Pipeline" / "Confirmed" status pill in job lists.
 */
export function CrmSyncIcon({ size = 11, color = "currentColor", strokeWidth = 2.2 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
      aria-hidden="true"
    >
      <polyline points="17 4 21 8 17 12" />
      <path d="M21 8H9a4 4 0 0 0-4 4v1" />
      <polyline points="7 20 3 16 7 12" />
      <path d="M3 16h12a4 4 0 0 0 4-4v-1" />
    </svg>
  );
}

export default function CrmSyncBadge({
  crmDisplayName = "CRM",
  title,
  size = 19,
  iconSize = 11,
  style = {},
}) {
  const tooltip = title || `Synced with ${crmDisplayName}`;

  return (
    <span
      role="status"
      aria-label={tooltip}
      title={tooltip}
      onClick={(e) => {
        // Prevent row expansion or navigation when clicking the badge
        e.stopPropagation();
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: "50%",
        background: "#f1f5f9",
        color: "#475569",
        border: "1px solid #cbd5e1",
        cursor: "pointer",
        flexShrink: 0,
        verticalAlign: "middle",
        transition: "all 0.15s ease",
        ...style,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "#e2e8f0";
        e.currentTarget.style.color = "#0f172a";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "#f1f5f9";
        e.currentTarget.style.color = "#475569";
      }}
    >
      <CrmSyncIcon size={iconSize} />
    </span>
  );
}
