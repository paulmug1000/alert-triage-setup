import React, { useState } from "react";

// Renders a project code inline. Codes longer than `maxLen` chars are truncated with "..."
// and can be tapped/clicked to expand. Keeps the job header line from breaking on mobile.
const TRUNCATED_CODE_MAX = 16;

export default function TruncatedCode({ code }) {
  const [expanded, setExpanded] = useState(false);
  
  if (!code) return null;
  
  const isLong = code.length > TRUNCATED_CODE_MAX;
  const display = isLong && !expanded ? code.slice(0, TRUNCATED_CODE_MAX) + "…" : code;
  
  return (
    <span
      style={{ fontWeight: "400", color: "#888", marginLeft: "6px", wordBreak: "break-all",
               cursor: isLong ? "pointer" : "default" }}
      title={isLong && !expanded ? code : undefined}
      onClick={isLong ? (e) => { e.stopPropagation(); setExpanded(v => !v); } : undefined}
    >
      ({display}{isLong && (
        <span style={{ color: "#aaa", fontSize: "10px", marginLeft: "3px" }}>
          {expanded ? "▲" : "▼"}
        </span>
      )})
    </span>
  );
}