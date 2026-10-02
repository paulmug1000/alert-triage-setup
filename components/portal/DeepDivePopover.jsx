import React, { useState, useEffect, useRef } from "react";

export default function DeepDivePopover({
  isOpen,
  targetRect,
  title,
  period,
  total,
  items = [],
  onClose,
}) {
  const popoverRef = useRef(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [position, setPosition] = useState({ top: 0, left: 0 });

  // Calculate smart position relative to window
  useEffect(() => {
    if (!isOpen || !targetRect) return;

    const popoverWidth = 380;
    const popoverHeight = 360; // approximate
    const padding = 12;

    const scrollY = window.scrollY || window.pageYOffset;
    const scrollX = window.scrollX || window.pageXOffset;

    let left = targetRect.left + (targetRect.width / 2) - (popoverWidth / 2) + scrollX;
    let top = targetRect.bottom + 8 + scrollY;

    // Viewport bounds check
    const maxLeft = window.innerWidth - popoverWidth - padding;
    if (left < padding) left = padding;
    if (left > maxLeft) left = maxLeft;

    // Check if overflows viewport bottom -> place above cell
    if (targetRect.bottom + popoverHeight > window.innerHeight) {
      const topAbove = targetRect.top - popoverHeight - 8 + scrollY;
      if (topAbove > scrollY + padding) {
        top = topAbove;
      }
    }

    setPosition({ top, left });
  }, [isOpen, targetRect]);

  // Click outside and escape key dismiss
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (e.key === "Escape") onClose();
    };

    const handleClickOutside = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    // Timeout prevents immediate trigger from the click that opened it
    const timer = setTimeout(() => {
      document.addEventListener("click", handleClickOutside);
    }, 50);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("click", handleClickOutside);
      clearTimeout(timer);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const filteredItems = items.filter((item) => {
    if (!searchTerm.trim()) return true;
    const q = searchTerm.toLowerCase().trim();
    return (
      (item.name && item.name.toLowerCase().includes(q)) ||
      (item.client && item.client.toLowerCase().includes(q)) ||
      (item.detail && item.detail.toLowerCase().includes(q))
    );
  });

  const formatGBP = (val) => {
    if (val === null || val === undefined || val === "") return "£0";
    if (typeof val === "number") {
      return (
        (val < 0 ? "-" : "") +
        "£" +
        Math.abs(Math.round(val)).toLocaleString("en-GB")
      );
    }
    const num = parseFloat(String(val).replace(/[£,]/g, ""));
    if (isNaN(num)) return String(val);
    return (
      (num < 0 ? "-" : "") +
      "£" +
      Math.abs(Math.round(num)).toLocaleString("en-GB")
    );
  };

  return (
    <div
      ref={popoverRef}
      style={{
        position: "absolute",
        top: `${position.top}px`,
        left: `${position.left}px`,
        width: "380px",
        maxHeight: "80vh",
        background: "#ffffff",
        border: "1px solid #cbd5e1",
        borderRadius: "10px",
        boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
        zIndex: 9999,
        fontFamily: "'Kumbh Sans', sans-serif",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        animation: "popoverIn 0.15s ease-out forwards",
      }}
    >
      <style>{`
        @keyframes popoverIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>

      {/* Header Bar */}
      <div
        style={{
          background: "#0047AB",
          padding: "12px 16px",
          color: "#ffffff",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderTopLeftRadius: "9px",
          borderTopRightRadius: "9px",
        }}
      >
        <div>
          <div style={{ fontSize: "14px", fontWeight: 700, letterSpacing: "-0.2px" }}>
            {title}
          </div>
          {period && (
            <div style={{ fontSize: "11px", color: "rgba(255, 255, 255, 0.8)", marginTop: "1px" }}>
              Period: {period}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          {total !== undefined && (
            <div style={{ fontSize: "15px", fontWeight: 800, color: "#ffffff" }}>
              {formatGBP(total)}
            </div>
          )}
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "rgba(255, 255, 255, 0.2)",
              border: "none",
              color: "#ffffff",
              width: "24px",
              height: "24px",
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              fontSize: "13px",
              fontWeight: 700,
              padding: 0,
            }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Filter input if multiple items */}
      {items.length > 5 && (
        <div style={{ padding: "8px 12px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
          <input
            type="text"
            placeholder="Filter contributors..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: "100%",
              padding: "4px 8px",
              borderRadius: "4px",
              border: "1px solid #cbd5e1",
              fontSize: "12px",
            }}
          />
        </div>
      )}

      {/* Itemized Contributor List */}
      <div
        style={{
          maxHeight: "320px",
          overflowY: "auto",
          padding: "4px 0",
        }}
      >
        {filteredItems.length === 0 ? (
          <div style={{ padding: "2rem 1rem", textAlign: "center", color: "#64748b", fontSize: "13px" }}>
            No individual items recorded for this period
          </div>
        ) : (
          filteredItems.map((item, idx) => (
            <div
              key={idx}
              style={{
                padding: "8px 16px",
                borderBottom: idx === filteredItems.length - 1 ? "none" : "1px solid #f1f5f9",
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: "10px",
                fontSize: "12px",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, color: "#1e293b", display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                  <span>{item.client ? `${item.client} - ` : ""}{item.name}</span>
                  {item.badge && (
                    <span
                      style={{
                        padding: "1px 6px",
                        borderRadius: "10px",
                        fontSize: "10px",
                        fontWeight: 600,
                        background: "#eff6ff",
                        color: "#1e40af",
                      }}
                    >
                      {item.badge}
                    </span>
                  )}
                </div>
                {item.detail && (
                  <div style={{ color: "#64748b", fontSize: "11px", marginTop: "2px" }}>
                    {item.detail}
                  </div>
                )}
              </div>

              <div
                style={{
                  fontWeight: 700,
                  color: "#0047AB",
                  whiteSpace: "nowrap",
                  textAlign: "right",
                  fontSize: "13px",
                }}
              >
                {formatGBP(item.amount)}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer Summary */}
      <div
        style={{
          padding: "8px 16px",
          background: "#f8fafc",
          borderTop: "1px solid #e2e8f0",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: "11px",
          color: "#64748b",
        }}
      >
        <span>{filteredItems.length} contributor{filteredItems.length === 1 ? "" : "s"}</span>
        <span>Click outside or press Esc to close</span>
      </div>
    </div>
  );
}
