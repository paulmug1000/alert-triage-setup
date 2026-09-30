import React from "react";

// Inline spinner SVG — shown inside buttons and loading states during async operations
export default function Spinner({ size = 16, color = "currentColor" }) {
  const numericSize =
    typeof size === "number"
      ? size
      : size === "xs"
      ? 12
      : size === "sm"
      ? 16
      : size === "md"
      ? 20
      : size === "lg"
      ? 28
      : parseInt(size, 10) || 16;

  return (
    <svg
      width={numericSize}
      height={numericSize}
      viewBox="0 0 24 24"
      fill="none"
      style={{
        display: "inline-block",
        verticalAlign: "middle",
        marginRight: "6px",
        flexShrink: 0,
        animation: "triage-spin 0.7s linear infinite"
      }}
    >
      <circle cx="12" cy="12" r="10" stroke={color} strokeWidth="3" strokeOpacity="0.25" />
      <path d="M12 2a10 10 0 0 1 10 10" stroke={color} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}