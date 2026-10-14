import React, { useState, useEffect } from "react";

/**
 * SplitMonthCard
 * 
 * Interactive monthly allocation card for uneven revenue split modals.
 * Allows users to edit values, delete values completely without premature reversion,
 * and easily lock or unlock individual months.
 */
export default function SplitMonthCard({
  month,
  mKey,
  isLocked,
  displayVal,
  currencySymbol = "£",
  onCommit,
  style = {}
}) {
  const [localVal, setLocalVal] = useState(displayVal);
  const [isFocused, setIsFocused] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  // Sync from props only when the input is NOT actively focused
  useEffect(() => {
    if (!isFocused) {
      setLocalVal(displayVal);
      setIsDirty(false);
    }
  }, [displayVal, isFocused]);

  const handleBlur = () => {
    setIsFocused(false);
    if (!isDirty && !isLocked) {
      // User clicked into an Auto box and clicked out without changing anything: keep Auto!
      return;
    }
    setIsDirty(false);
    const trimmed = String(localVal).trim();
    if (trimmed === "") {
      // Empty input commits an unlock back to Auto
      onCommit(mKey, null);
    } else {
      const parsed = parseFloat(trimmed);
      if (isNaN(parsed)) {
        onCommit(mKey, null);
      } else {
        onCommit(mKey, parsed);
      }
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    }
  };

  return (
    <div
      style={{
        background: "#ffffff",
        padding: "8px 10px",
        borderRadius: "6px",
        border: `1px solid ${isLocked ? "#0284c7" : "#cbd5e1"}`,
        boxShadow: isLocked ? "0 1px 3px rgba(2, 132, 199, 0.15)" : "none",
        transition: "border-color 0.15s ease, box-shadow 0.15s ease",
        ...style
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: "11px",
          fontWeight: isLocked ? "700" : "600",
          color: isLocked ? "#0284c7" : "#64748b",
          marginBottom: "5px"
        }}
      >
        <span>{month}</span>
        {isLocked ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onCommit(mKey, null);
            }}
            title="Click to unlock and return to auto-split"
            style={{
              fontSize: "10px",
              padding: "1px 6px",
              borderRadius: "4px",
              background: "#e0f2fe",
              color: "#0369a1",
              border: "1px solid #bae6fd",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "3px",
              fontWeight: 600
            }}
          >
            <span>🔒 Locked</span>
            <span style={{ fontSize: "11px", opacity: 0.8 }}>✕</span>
          </button>
        ) : (
          <span
            style={{
              fontSize: "10px",
              padding: "1px 5px",
              borderRadius: "4px",
              background: "#f1f5f9",
              color: "#64748b",
              fontWeight: 500
            }}
          >
            Auto
          </span>
        )}
      </div>

      <div style={{ position: "relative" }}>
        <span
          style={{
            position: "absolute",
            left: "8px",
            top: "50%",
            transform: "translateY(-50%)",
            color: isLocked ? "#0284c7" : "#94a3b8",
            fontSize: "12px",
            fontWeight: "600",
            pointerEvents: "none"
          }}
        >
          {currencySymbol}
        </span>
        <input
          type="number"
          step="0.01"
          placeholder="Auto"
          value={localVal}
          onFocus={(e) => {
            setIsFocused(true);
            setIsDirty(false);
            e.target.select();
          }}
          onChange={(e) => {
            setIsDirty(true);
            setLocalVal(e.target.value);
          }}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          style={{
            width: "100%",
            padding: "5px 6px 5px 20px",
            border: `1px solid ${isLocked ? "#0284c7" : isFocused ? "#94a3b8" : "#e2e8f0"}`,
            background: isLocked ? "#f0f9ff" : "#f8fafc",
            borderRadius: "5px",
            fontSize: "12px",
            fontWeight: isLocked ? "700" : "500",
            color: isLocked ? "#0369a1" : "#1e293b",
            boxSizing: "border-box",
            outline: "none",
            transition: "all 0.15s ease"
          }}
        />
      </div>
    </div>
  );
}
